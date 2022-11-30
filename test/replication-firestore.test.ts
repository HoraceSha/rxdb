/**
 * this test checks the integration with couchdb
 * run 'npm run test:couchdb' to use it
 * You need a running couchdb-instance on port 5984
 * Run 'npm run couch:start' to spawn a docker-container
 */
import assert from 'assert';

import {
    randomCouchString,
    addRxPlugin,
    RxCollection,
    ensureNotFalsy
} from '../';

import * as firebase from 'firebase/app';

import * as humansCollection from './helper/humans-collection';
import * as schemaObjects from './helper/schema-objects';

import config from './unit/config';

import {
    CollectionReference,
    getFirestore,
    collection as getFirestoreCollection,
    connectFirestoreEmulator,
    getDocs,
    query,
    doc as DocRef,
    setDoc,
    serverTimestamp,
    where,
    orderBy,
    limit} from 'firebase/firestore';
import {
    FirestoreOptions,
    RxDBReplicationFirestorePlugin,
    RxFirestoreReplicationState
} from '../plugins/replication-firestore';
import { ensureCollectionsHaveEqualState } from './helper/test-util';

addRxPlugin(RxDBReplicationFirestorePlugin);

/**
 * The tests for the firstore replication plugin
 * do not run in the normal test suite
 * because it is too slow to setup the firstore backend emulators.
 */
describe('replication-firstore.test.js', () => {
    /**
     * Use a low batchSize in all tests
     * to make it easier to test boundaries.
     */
    const batchSize = 5;
    type TestDocType = schemaObjects.HumanWithTimestampDocumentType;
    async function getAllDocsOfFirestore(firestore: FirestoreOptions<TestDocType>): Promise<TestDocType[]> {
        const result = await getDocs(query(firestore.collection));
        return result.docs.map(d => d.data()) as any;
    }
    const projectId = randomCouchString(10);
    const app = firebase.initializeApp({
        projectId,
        databaseURL: 'http://localhost:8080?ns=' + projectId
    });
    const database = getFirestore(app);
    connectFirestoreEmulator(database, 'localhost', 8080);

    function getFirestoreState(): FirestoreOptions<TestDocType> {
        const useCollection: CollectionReference<TestDocType> = getFirestoreCollection(database, randomCouchString(10)) as any;
        return {
            projectId,
            collection: useCollection,
            database
        };
    }
    function ensureReplicationHasNoErrors(replicationState: RxFirestoreReplicationState<any>) {
        /**
         * We do not have to unsubscribe because the observable will cancel anyway.
         */
        replicationState.error$.subscribe(err => {
            console.error('ensureReplicationHasNoErrors() has error:');
            console.log(err);
            if (err?.parameters?.errors) {
                throw err.parameters.errors[0];
            }
            throw err;
        });
    }
    function syncFirestore<RxDocType = TestDocType>(
        collection: RxCollection<RxDocType>,
        firestoreState: FirestoreOptions<RxDocType>
    ): RxFirestoreReplicationState<RxDocType> {
        const replicationState = collection.syncFirestore({
            firestore: firestoreState,
            pull: {
                batchSize
            },
            push: {
                batchSize
            }
        });
        ensureReplicationHasNoErrors(replicationState);
        return replicationState;
    }
    it('log some stuff', () => {
        console.log('STORAGE: ' + config.storage.name);
    });
    it('preconditions', async () => {
        const firestoreState = await getFirestoreState();

        // it should be able to query sorted by serverTimestamp
        await setDoc(DocRef(firestoreState.collection, 'older'), {
            id: 'older',
            serverTimestamp: serverTimestamp()
        } as any);
        await setDoc(DocRef(firestoreState.collection, 'younger'), {
            id: 'younger',
            serverTimestamp: serverTimestamp()
        } as any);
        const docsOnServer = await getAllDocsOfFirestore(firestoreState);
        const olderDoc = ensureNotFalsy(docsOnServer.find(d => d.id === 'older'));
        const queryTimestamp = (olderDoc as any).serverTimestamp.toDate();
        const newerQuery = query(firestoreState.collection,
            where('serverTimestamp', '>', queryTimestamp),
            orderBy('serverTimestamp', 'asc'),
            limit(10)
        );
        const queryResult = await getDocs<TestDocType>(newerQuery as any);
        assert.strictEqual(queryResult.docs.length, 1);
        assert.strictEqual(
            ensureNotFalsy(queryResult.docs[0]).data().id,
            'younger'
        );
    });
    it('push replication to client-server', async () => {
        const collection = await humansCollection.createHumanWithTimestamp(2, undefined, false);

        const firestoreState = await getFirestoreState();

        const replicationState = syncFirestore(collection, firestoreState);
        ensureReplicationHasNoErrors(replicationState);
        await replicationState.awaitInitialReplication();

        let docsOnServer = await getAllDocsOfFirestore(firestoreState);
        assert.strictEqual(docsOnServer.length, 2);

        // insert another one
        await collection.insert(schemaObjects.humanWithTimestamp());
        await replicationState.awaitInSync();

        docsOnServer = await getAllDocsOfFirestore(firestoreState);
        assert.strictEqual(docsOnServer.length, 3);

        // update one
        const doc = await collection.findOne().exec(true);
        await doc.atomicPatch({ age: 100 });
        await replicationState.awaitInSync();
        docsOnServer = await getAllDocsOfFirestore(firestoreState);
        assert.strictEqual(docsOnServer.length, 3);
        const serverDoc = ensureNotFalsy(docsOnServer.find(d => d.id === doc.primary));
        assert.strictEqual(serverDoc.age, 100);

        // delete one
        await doc.remove();
        await replicationState.awaitInSync();
        docsOnServer = await getAllDocsOfFirestore(firestoreState);
        // must still have 3 because there are no hard deletes
        assert.strictEqual(docsOnServer.length, 3);
        assert.ok(docsOnServer.find(d => (d as any)._deleted));

        collection.database.destroy();
    });
    it('two collections', async () => {
        const collectionA = await humansCollection.createHumanWithTimestamp(1, undefined, false);
        const collectionB = await humansCollection.createHumanWithTimestamp(1, undefined, false);

        const firestoreState = await getFirestoreState();
        const replicationStateA = syncFirestore(collectionA, firestoreState);

        ensureReplicationHasNoErrors(replicationStateA);
        await replicationStateA.awaitInitialReplication();


        const replicationStateB = syncFirestore(collectionB, firestoreState);
        ensureReplicationHasNoErrors(replicationStateB);
        await replicationStateB.awaitInitialReplication();

        await replicationStateA.awaitInSync();

        await ensureCollectionsHaveEqualState(collectionA, collectionB);

        // insert one
        await collectionA.insert(schemaObjects.humanWithTimestamp({ id: 'insert', name: 'InsertName' }));
        await replicationStateA.awaitInSync();

        await replicationStateB.awaitInSync();
        await ensureCollectionsHaveEqualState(collectionA, collectionB);

        // delete one
        await collectionB.findOne().remove();
        await replicationStateB.awaitInSync();
        await replicationStateA.awaitInSync();
        await ensureCollectionsHaveEqualState(collectionA, collectionB);

        // insert many
        await collectionA.bulkInsert(
            new Array(10)
                .fill(0)
                .map(() => schemaObjects.humanWithTimestamp({ name: 'insert-many' }))
        );
        await replicationStateA.awaitInSync();

        await replicationStateB.awaitInSync();
        await ensureCollectionsHaveEqualState(collectionA, collectionB);

        // insert at both collections at the same time
        await Promise.all([
            collectionA.insert(schemaObjects.humanWithTimestamp({ name: 'insert-parallel-A' })),
            collectionB.insert(schemaObjects.humanWithTimestamp({ name: 'insert-parallel-B' }))
        ]);
        await replicationStateA.awaitInSync();
        await replicationStateB.awaitInSync();
        await replicationStateA.awaitInSync();
        await replicationStateB.awaitInSync();
        await ensureCollectionsHaveEqualState(collectionA, collectionB);

        collectionA.database.destroy();
        collectionB.database.destroy();
    });
});
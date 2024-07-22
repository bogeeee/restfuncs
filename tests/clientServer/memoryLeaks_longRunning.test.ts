// ***********************
// Run with ../../package.json/scripts/tests:memoryLeakTests
// If you see the program crash, then consider the test failed cause it consumed more memory than allowed
// ***********************

import {ServerSession as ServerSession, ServerSessionOptions} from "restfuncs-server";
import express from "express";
import {ClientSocketConnection, RestfuncsClient} from "restfuncs-client";
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import {Readable} from "node:stream";
import {diagnosis_looksLikeJSON, shieldTokenAgainstBREACH_unwrap} from "restfuncs-server/Util";
import {CommunicationError} from "restfuncs-server/CommunicationError";
import session from "express-session";
import {restfuncsExpress, ServerOptions} from "restfuncs-server/Server";
import {CookieSession, WelcomeInfo} from "restfuncs-common";
import nacl from "tweetnacl";
import nacl_util from "tweetnacl-util";
import {remote, RemoteMethodOptions} from "restfuncs-server/ServerSession";
import {
    createServer,
    expectAsyncFunctionToThrow,
    resetGlobalState,
    runClientServerTests,
    runRawFetchTests,
    Service,
    standardOptions
} from "./lib";
import {WeakValueMap} from "restfuncs-common/WeakValueMap";

// Config:
const leakSizeMiB = 1000; // How much memory should every test try to leak. In MiB. So the test can be watched for fail from the outside by giving it half that memory. i.e. on gnu with "ulimit -d _size_in_kb_"
jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible


beforeEach(() => {
    resetGlobalState();
});;

describe("callbacks", () => {
    class ServerAPI extends ServerSession {
        @remote()
        withCallback(cb: () => any) {

        }
    }
    const bufferSize = 50000;
        const iterations = (leakSizeMiB * 1024 * 1024)/ bufferSize;
    test(`Callbacks should be freed on the client: ${iterations} iterations`, () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        // The server should report to the client that myFn was GC'ed there
        for(let i =0;i<iterations;i++) {

            let buffer = Buffer.alloc(bufferSize);
            function myFn() {
                console.log(buffer); // Reference the buffer
            }

            await apiProxy.withCallback(myFn);

            if(i %100 === 0) {
                //runGarbageCollection();
            }
        }
    }, {
        useSocket: true
    }));
});

type TargetObject = {
    diag_theKey: any;
}

/**
 * These tests are placed here because they need to invoke the gc.
 */
describe("WeakValueMap", () => {

    for(const {makerFn, title} of [{makerFn: makeObject, title: "objects"},{makerFn: makeFunctionObject, title: "functions"}]) {
        test(`Add entries and check if they exist (with ${title})`, () => {
            let weakValueMap = new WeakValueMap<string, TargetObject>();
            const a = makerFn("a");
            const b = makerFn("b");

            weakValueMap.set("a", a);
            weakValueMap.set("b", b);


            expect(weakValueMap.has("a")).toBeTruthy()
            expect(weakValueMap.has("b")).toBeTruthy()
            expect(weakValueMap.has("nonExistent")).toBeFalsy()

            expect(weakValueMap.get("a")).toBeDefined()
            expect(weakValueMap.get("b")).toBeDefined()

            expect(weakValueMap.get("a")?.diag_theKey).toStrictEqual("a");
            expect(weakValueMap.get("b")?.diag_theKey).toStrictEqual("b");
        });

        it(`Should delete entries after garbage collection (with ${title})`, async () => {
            let weakValueMap = new WeakValueMap<string, TargetObject>();

            function addA() {
                const a = makerFn("a");
                weakValueMap.set("a", a);
            }
            addA();

            const b = makerFn("b");
            weakValueMap.set("b", b);

            await waitForATick(); // Workaround: Things from this job (event loop run) don't get gc'ed. So we give it time to breathe

            runGarbageCollection();

            expect(weakValueMap.has("a")).toBeFalsy()
            expect(weakValueMap.has("b")).toBeTruthy()

            expect(weakValueMap.get("a")).toBeUndefined()
            expect(weakValueMap.get("b")).toBeDefined()

            expect(weakValueMap.get("b")?.diag_theKey).toStrictEqual("b");
        });

        it(`Should call the entryLostCallback function after garbage collection - triggered by query (with ${title})`, async () => {
            let lastLostKey: any;
            let weakValueMap = new WeakValueMap<string, TargetObject>([], (key) => {
                lastLostKey = key}
            );

            function addA() {
                const a = makerFn("a");
                weakValueMap.set("a", a);
            }
            addA();

            const b = makerFn("b");
            weakValueMap.set("b", b);

            await waitForATick(); // Workaround: Things from this job (event loop run) don't get gc'ed. So we give it time to breathe

            runGarbageCollection();

            expect(weakValueMap.has("a")).toBeFalsy() // Query, this should trigger the

            expect(lastLostKey).toBe("a");

        });

        it(`Should call the entryLostCallback function after garbage collection - triggered by finalizationregistry (with ${title})`, async () => {
            let lastLostKey: any;
            let weakValueMap = new WeakValueMap<string, TargetObject>([], (key) => {
                lastLostKey = key}
            );

            function addA() {
                const a = makerFn("a");
                weakValueMap.set("a", a);
            }
            addA();

            const b = makerFn("b");
            weakValueMap.set("b", b);

            await waitForATick(); // Workaround: Things from this job (event loop run) don't get gc'ed. So we give it time to breathe

            runGarbageCollection();

            await waitForATick();

            expect(lastLostKey).toBe("a");

        });

        /*
        // Not yet implemented cause not needed yet:
        test(`Iterate keys (with ${title})`, () => {
            let weakValueMap = new WeakValueMap<string, TargetObject>();
            const a = makerFn("a");
            const b = makerFn("b");
            const c = makerFn("c");

            expect(weakValueMap.keys()).toStrictEqual(["a", "b", "c"])
        });

        test(`Iterate entries (with ${title})`, () => {
            let weakValueMap = new WeakValueMap<string, TargetObject>();
            const a = makerFn("a");
            const b = makerFn("b");
            const c = makerFn("c");

            expect([...weakValueMap.entries()].length).toBe(3);
        });

        test(`Iterate keys with numeric keys (with ${title})`, () => {
            let weakValueMap = new WeakValueMap<string, TargetObject>();
            const a = makerFn(1);
            const b = makerFn(-2);
            const c = makerFn(8);

            expect(weakValueMap.keys()).toStrictEqual([1, -2, 8])
        });
        */
    }

    function makeObject(key: any): TargetObject {
        return {
            diag_theKey: key
        }
    }
    function makeFunctionObject(key: any): TargetObject {
        const result = function () {};
        result.diag_theKey = key;
        return result as any as TargetObject;
    }
});

function runGarbageCollection() {
    if(!gc) {
        throw new Error("No garbage collection hooks available but this test needs such. You must run node with the --expose-gc parameter.");
    }
    gc();
}

function waitForATick(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        setTimeout(resolve);
    });
}
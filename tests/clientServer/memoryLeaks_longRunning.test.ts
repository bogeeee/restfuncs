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
        }
    }, {
        useSocket: true
    }));
});
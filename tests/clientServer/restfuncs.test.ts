import {ServerSession as ServerSession, ServerSessionOptions} from "restfuncs-server";
import express from "express";
import {ClientSocketConnection, RestfuncsClient, ServerError} from "restfuncs-client";
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

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible


beforeEach(() => {
    resetGlobalState();
});;

describe("getRemoteMethodOptions", () => {
    class BaseService extends ServerSession {
        // Elevate to public
        static getRemoteMethodOptions(name: string) {
            return super.getRemoteMethodOptions(name);
        }

        // Elevate to public
        static checkIfMethodHasRemoteDecorator(methodName: string) {
            return super.checkIfMethodHasRemoteDecorator(methodName);
        }
    }

    test("No @remote decorator", () => {
        class MyService extends BaseService {
            myMethod() {
            }
        }
        expect( () => MyService.checkIfMethodHasRemoteDecorator("myMethod")).toThrow("@remote")
    })

    test("No @remote decorator but at parent ", () => {
        class MyServiceParent extends BaseService {
            @remote
            myMethod() {
            }
        }

        class MyService extends MyServiceParent {
            myMethod() {
            }
        }
        expect( () => MyService.checkIfMethodHasRemoteDecorator("myMethod")).toThrow("@remote")
    })

    it("Should still throw with no @remote decorator but with defaultRemoteMethodOptions set", () => {
        class MyService extends BaseService {
            static defaultRemoteMethodOptions: RemoteMethodOptions = {}
            myMethod() {
            }
        }
        expect( () => MyService.checkIfMethodHasRemoteDecorator("myMethod")).toThrow("@remote")
    })

    test("With @remote decorator", () => {
        class MyService extends BaseService {
            @remote()
            myMethod() {
            }
        }

        let options = MyService.getRemoteMethodOptions("myMethod");
        expect(options).toBeDefined()
    })

    test("Check for proper defaults", () => {
        class MyService extends BaseService {
            @remote()
            myMethod() {
            }
        }

        let options = MyService.getRemoteMethodOptions("myMethod");
        expect(options.isSafe).toBeFalsy()
        expect(options.validateArguments !== false).toBeTruthy()
        expect(options.validateResult !== false).toBeTruthy()
        expect(options.trimArguments === undefined).toBeTruthy()
        expect(options.trimResult !== false).toBeTruthy()
        expect(options.validateCallbackArguments !== false).toBeTruthy()
        expect(options.validateCallbackResult !== false).toBeTruthy()
        expect(options.apiBrowserOptions!.needsAuthorization).toBeFalsy()
    })

    test("inherited from parent method and parent defaultRemoteMethodOptions", () => {

        let provokingChanges: RemoteMethodOptions = {
            isSafe: true, // Should not be inherited
            validateArguments: false,// Should not be inherited
            validateResult: false, // Should not be inherited
            trimArguments: false, // Should be inherited
            trimResult: false, // Should not be inherited
            validateCallbackArguments: false, // Should not be inherited
            validateCallbackResult: false, // Should not be inherited
            apiBrowserOptions: {needsAuthorization: true} // thould be inherited

        };

        class MyServiceParent extends BaseService {
            static defaultRemoteMethodOptions: RemoteMethodOptions = {...provokingChanges, isSafe: undefined}

            @remote(provokingChanges)
            myMethod() {
            }
        }

        class MyService extends MyServiceParent {
            static defaultRemoteMethodOptions: RemoteMethodOptions = {}
            @remote()
            myMethod() {
            }
        }

        let options = MyService.getRemoteMethodOptions("myMethod");
        expect(options.isSafe).toBeFalsy()
        expect(options.validateArguments !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.validateResult !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.trimArguments === false).toBeTruthy()
        expect(options.trimResult !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.validateCallbackArguments !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.validateCallbackResult !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.apiBrowserOptions!.needsAuthorization === true).toBeTruthy() // Should be affected by MyServiceParent
    })



    test("defaultRemoteMethodOptions options at this level", () => {
        class MyService extends BaseService {
            static defaultRemoteMethodOptions: RemoteMethodOptions = {
                validateArguments: false,// Should be used
                validateResult: false, // Should be used
                trimArguments: false, // Should be used
                trimResult: false, // Should be used
                validateCallbackArguments: false, // Should be used
                validateCallbackResult: false, // Should be used
                apiBrowserOptions: {needsAuthorization: true} // Should be used
            }

            @remote()
            myMethod() {
            }

            @remote()
            mySubclassOnlyMethod() {
            }
        }

        for(const methodName of ["myMethod", "mySubclassOnlyMethod"]) {
            let options = MyService.getRemoteMethodOptions(methodName);
            expect(options.isSafe).toBeFalsy()
            expect(options.validateArguments === false).toBeTruthy()
            expect(options.validateResult === false).toBeTruthy()
            expect(options.trimArguments === false).toBeTruthy()
            expect(options.trimResult === false).toBeTruthy()
            expect(options.validateCallbackArguments === false).toBeTruthy()
            expect(options.validateCallbackResult === false).toBeTruthy()
            expect(options.apiBrowserOptions!.needsAuthorization).toBeTruthy()
        }
    })


    test("Actual defaultRemoteMethodOptions, but method inherited", () => {
        class MyServiceParent extends BaseService {
            @remote()
            myMethod() {
            }
        }

        class MyService extends MyServiceParent {
            static defaultRemoteMethodOptions: RemoteMethodOptions = {
                validateArguments: false,// Should not be used
                validateResult: false, // Should not be used
                trimArguments: false, // Should not be used (but we could do so)
                trimResult: false, // Should not be used
                validateCallbackArguments: false, // Should not be used
                validateCallbackResult: false, // Should not be used
                apiBrowserOptions: {needsAuthorization: true} // should not be used
            }
            // myMethod() {} // Inherited
        }

        let options = MyService.getRemoteMethodOptions("myMethod");
        expect(options.isSafe).toBeFalsy()
        expect(options.validateArguments !== false).toBeTruthy() // Should not be affected
        expect(options.validateResult !== false).toBeTruthy() // Should not be affected
        expect(options.trimArguments === undefined).toBeTruthy() // Should not be affected
        expect(options.trimResult !== false).toBeTruthy() // Should not be affected
        expect(options.validateCallbackArguments !== false).toBeTruthy() // Should not be affected
        expect(options.validateCallbackResult !== false).toBeTruthy() // Should not be affected
        expect(options.apiBrowserOptions!.needsAuthorization === undefined).toBeTruthy() // Should not be affected
    })


    test("Overridden but parent has no @remote() decorator - with parent's defaultRemoteMethodOptions", () => {

        let provokingChanges: RemoteMethodOptions = {
            isSafe: true, // Should not be inherited
            validateArguments: false,// Should not be inherited
            validateResult: false, // Should not be inherited
            trimArguments: false, // Should be inherited
            trimResult: false, // Should not be inherited
            validateCallbackArguments: false, // Should not be inherited
            validateCallbackResult: false, // Should not be inherited
            apiBrowserOptions: {needsAuthorization: true} // thould be inherited

        };

        class MyServiceParent extends BaseService {
            static defaultRemoteMethodOptions: RemoteMethodOptions = {...provokingChanges, isSafe: undefined}

            myMethod() {
            }
        }

        class MyService extends MyServiceParent {
            static defaultRemoteMethodOptions: RemoteMethodOptions = {}
            @remote()
            myMethod() {
            }
        }

        let options = MyService.getRemoteMethodOptions("myMethod");
        expect(options.isSafe).toBeFalsy()
        expect(options.validateArguments !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.validateResult !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.trimArguments === false).toBeTruthy()
        expect(options.trimResult !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.validateCallbackArguments !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.validateCallbackResult !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.apiBrowserOptions!.needsAuthorization === true).toBeTruthy() // Should be affected by MyServiceParent
    })

    test("Just parent's defaultRemoteMethodOptions", () => {

        let provokingChanges: RemoteMethodOptions = {
            isSafe: true, // Should not be inherited
            validateArguments: false,// Should not be inherited
            validateResult: false, // Should not be inherited
            trimArguments: false, // Should be inherited
            trimResult: false, // Should not be inherited
            validateCallbackArguments: false, // Should not be inherited
            validateCallbackResult: false, // Should not be inherited
            apiBrowserOptions: {needsAuthorization: true} // thould be inherited

        };

        class MyServiceParent extends BaseService {
            static defaultRemoteMethodOptions: RemoteMethodOptions = {...provokingChanges, isSafe: undefined}

            // no myMethod declared here at all
        }

        class MyService extends MyServiceParent {
            static defaultRemoteMethodOptions: RemoteMethodOptions = {}
            @remote()
            myMethod() {
            }
        }

        let options = MyService.getRemoteMethodOptions("myMethod");
        expect(options.isSafe).toBeFalsy()
        expect(options.validateArguments !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.validateResult !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.trimArguments === false).toBeTruthy()
        expect(options.trimResult !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.validateCallbackArguments !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.validateCallbackResult !== false).toBeTruthy() // Should not be affected by MyServiceParent
        expect(options.apiBrowserOptions!.needsAuthorization === true).toBeTruthy() // Should be affected by MyServiceParent
    })
});


test('Simply call a Void method', async () => {
    await runClientServerTests({
            myVoidMethod() {
            }
        },
        async (apiProxy) => {
            expect(await apiProxy.myVoidMethod()).toBeUndefined();
        }
    );
});

test('Simple api call', async () => {
    await runClientServerTests({
            myMethod(arg1, arg2) {
                expect(arg1).toBe("hello1");
                expect(arg2).toBe("hello2");
                return "OK";
            }
        },
        async (apiProxy) => {
            expect(await apiProxy.myMethod("hello1", "hello2")).toBe("OK");
        }
    );
});

test('Engine.io sockets', async () => {
    await runClientServerTests({
            myMethod(arg1, arg2) {
                expect(arg1).toBe("hello1");
                expect(arg2).toBe("hello2");
                return "OK";
            }
        },
        async (apiProxy) => {
            expect(await apiProxy.myMethod("hello1", "hello2")).toBe("OK");
        }, {useSocket: true}
    );
});

test('Non restfuncsExpress server', async () => {
    class GreeterService extends Service {
        greet(name: string) {
            return `hello ${name} from the server`
        }
    }

    // This should even work without a session handler, cause when no tokens are required and no session is accessed. TODO: do we need to set the csrfProtectionMode on the client ?

    const app = express();
    app.use("/greeterAPI", GreeterService.createExpressHandler());
    const server = app.listen();

    try {
        // @ts-ignore
        const serverPort = server.address().port;

        const greeterService = new RestfuncsClient<GreeterService>(`http://localhost:${serverPort}/greeterAPI`).proxy
        expect(await greeterService.greet("Bob")).toBe("hello Bob from the server");
    }
    finally {
        // shut down server
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});


test('Proper example with express and type support', async () => {
    class GreeterService extends Service {

        async greet(name: string) {
            return `hello ${name} from the server`
        }

        // ... more functions go here
    }


    const app = restfuncsExpress();
    app.use("/greeterAPI", GreeterService.createExpressHandler());
    const server = app.listen();

    try {
        // @ts-ignore
        const serverPort = server.address().port;

        const greeterService = new RestfuncsClient<GreeterService>(`http://localhost:${serverPort}/greeterAPI`).proxy
        expect(await greeterService.greet("Bob")).toBe("hello Bob from the server");
    }
    finally {
        // shut down server
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
})

test('test with different api paths', async () => {
    for(let path of ["","/", "/api/","/sub/api"]) {
        await runClientServerTests({
                myMethod(arg1, arg2) {
                    expect(arg1).toBe("hello1");
                    expect(arg2).toBe("hello2");
                    return "OK";
                }
            },
            async (apiProxy) => {
                expect(await apiProxy.myMethod("hello1", "hello2")).toBe("OK");
            }
            ,{path}
        );
    }
});

test('Exceptions', async () => {
    class CustomRestError extends CommunicationError {
        myProperty: string;
    }

    await runClientServerTests(new class extends Service {
            static options: ServerSessionOptions = {
                allowThrowNonErrors: true
            }

            throwAnError() {
                throw new Error("Expected test error");
            }

            async asyncThrowAnError() {
                throw new Error("Expected test error");
            }

            throwsString() {
                throw "Expected test error";
            }

            async asyncThrowsString() {
                throw "Expected test error";
            }

            async throwSomething(ball: any) {
                throw ball;
            }

            throwCustomRestError() {
                const e = new CustomRestError("test");
                e.myProperty = "test";
                throw e;
            }

            usualFunc() {

            }

        }
        ,async (apiProxy) => {
            const client = new RestfuncsClient(`http://localhost:${63000}/apiXY`).proxy; // Connect to server port that does not yet exist


            await expectAsyncFunctionToThrow(async () => {
                // @ts-ignore
                const result = await client.usualFunc();
                console.log(result);
            });

            await expectAsyncFunctionToThrow(async () => {
                await apiProxy.throwAnError();
            },"Expected test error");

            await expectAsyncFunctionToThrow(async () => {
                await apiProxy.throwsString();
            },"Expected test error");

            await expectAsyncFunctionToThrow(async () => {
                await apiProxy.asyncThrowAnError();
            },"Expected test error");

            await expectAsyncFunctionToThrow(async () => {
                await apiProxy.asyncThrowsString();
            },"Expected test error");

            // Try+catch with any non-Error value:
            for(const ball of variousDifferentTypes) {
                let caught;
                try {
                    await apiProxy.throwSomething(ball);
                    fail(new Error(`Should have thrown. Ball=${ball}`))
                }
                catch (x) {
                    caught = x;
                }

                expect(caught).toStrictEqual(ball);
            }

            // Custom CommunicationError with attached property:
            try {
                await apiProxy.throwCustomRestError();
                fail(new Error(`Should have thrown`))
            }
            catch (x) {
                expect(x.cause.myProperty).toBe("test");
            }

    });
});

test('Safe methods decorators', async () => {

    class BaseService extends ServerSession {
        static options = {checkArguments: false, logErrors: false, exposeErrors: true}

        // Escalate to 'public'
        public static methodIsSafe(name) {
            return this.getRemoteMethodOptions(name)?.isSafe
        }
    }

    class Service1 extends BaseService {
    }

    class Service2 extends BaseService {
    }

    class Service3 extends BaseService {
    }

    expect(Service1.methodIsSafe("getIndex")).toBeTruthy()

    // With overwrite and isSafe:
    class ServiceA extends BaseService {
        @remote({isSafe: true})
        async getIndex() {
            return "";
        }
    }

    expect(ServiceA.methodIsSafe("getIndex")).toBeTruthy()

    // With overwrite but not marked as safe:
    class ServiceB extends BaseService {
        @remote()
        async getIndex() {
            return "";
        }
    }

    expect(ServiceB.methodIsSafe("getIndex")).toBeFalsy()
});

test('Safe methods call', async () => {

    let wasCalled = false; // TODO: We could simply check if methods returned successfully as the non-browser client shouldn't restrict reading the result. But now to lazy to change that.
    class BaseService extends ServerSession{
        unsafeFromBase() {
            wasCalled = true;
            return "ok";
        }

        @remote({isSafe: true})
        safeFromBase() {
            wasCalled = true;
            return "ok";
        }

        @remote({isSafe: true})
        overwriteMe1() {
            wasCalled = true;
            return "ok";
        }

        @remote({isSafe: true})
        overwriteMe2() {
            wasCalled = true;
            return "ok";
        }
    }

    class MyService extends BaseService{
        unsafeTest() {
            wasCalled = true;
            return "ok";
        }

        @remote({isSafe: true})
        safeTest() {
            wasCalled = true;
            return "ok";
        }

        @remote({isSafe: true})
        overwriteMe1() {
            wasCalled = true;
            return "ok";
        }

        // forgot the @remote({isSafe: true}) annotation -> should not execute the call
        overwriteMe2() {
            wasCalled = true;
            return "ok";
        }
    }



    await runRawFetchTests(new MyService() , async (baseUrl) => {
        async function checkFunctionWasCalled(functionName, expected: boolean) {
            wasCalled = false;
            await fetch(`${baseUrl}/${functionName}`, {method: "GET"});
            expect(wasCalled).toStrictEqual(expected);
        }

        await checkFunctionWasCalled("unsafeTest", false);
        await checkFunctionWasCalled("safeTest", true);

        await checkFunctionWasCalled("unsafeFromBase", false);
        await checkFunctionWasCalled("safeFromBase", true);

        await checkFunctionWasCalled("overwriteMe1", true);
        await checkFunctionWasCalled("overwriteMe2", false);
    });
})

test('auto convert parameters', async () => {

    await runRawFetchTests(new class extends Service {
        static options: ServerSessionOptions = {devDisableSecurity: false}
        getNum(num?: number) {
            return num;
        }

        getBigInt(num?: BigInt) {
            return num;
        }

        getBool(bool?: boolean) {
            return bool;
        }

        getDate(date?: Date) {
            return date;
        }

    }(), async (baseUrl) => {

        async function fetchJson(input: RequestInfo, init?: RequestInit) {
            const response = await fetch(input, {
                headers: {"Content-Type": "application/json", "Accept": "application/brillout-json"},
                ...init
            });
            // Error handling:
            if (response.status !== 200) {
                throw new Error("server error: " + await response.text())
            }

            return brilloutJsonParse(await response.text());
        }

        // **** Query (string) ***

        // Number:
        expect(await fetchJson(`${baseUrl}/getNum/123`, {method: "GET"})).toStrictEqual(123);
        expect(await fetchJson(`${baseUrl}/getNum/NaN`, {method: "GET"})).toStrictEqual(Number.NaN);
        expect(await fetchJson(`${baseUrl}/getNum/Infinity`, {method: "GET"})).toStrictEqual(Number.POSITIVE_INFINITY);
        expect(await fetchJson(`${baseUrl}/getNum/-12345.67`, {method: "GET"})).toStrictEqual(-12345.67);
        expect(await fetchJson(`${baseUrl}/getNum?num=`, {method: "GET"})).toStrictEqual(undefined);

        // BigInt:
        expect(await fetchJson(`${baseUrl}/getBigInt/123`, {method: "GET"})).toStrictEqual(123n);
        expect(await fetchJson(`${baseUrl}/getBigInt/9007199254740992`, {method: "GET"})).toStrictEqual(9007199254740992n);
        expect(await fetchJson(`${baseUrl}/getBigInt/0x1fffffffffffff`, {method: "GET"})).toStrictEqual(0x1fffffffffffffn);
        expect(await fetchJson(`${baseUrl}/getBigInt?num=`, {method: "GET"})).toStrictEqual(undefined);


        // Bool:
        expect(await fetchJson(`${baseUrl}/getBool/true`, {method: "GET"})).toStrictEqual(true);
        expect(await fetchJson(`${baseUrl}/getBool/false`, {method: "GET"})).toStrictEqual(false);
        expect(await fetchJson(`${baseUrl}/getBool?bool=`, {method: "GET"})).toStrictEqual(undefined);

        // Date:
        const strDate = "2023-04-05T16:30:45.712Z";
        const date = new Date(strDate);
        expect(await fetchJson(`${baseUrl}/getDate?date=`, {method: "GET"})).toStrictEqual(undefined);
        expect(await fetchJson(`${baseUrl}/getDate?date=${encodeURIComponent(strDate)}`, {method: "GET"})).toStrictEqual(date);
        expect(await fetchJson(`${baseUrl}/getDate?date=`, {method: "GET"})).toStrictEqual(undefined);


        // *** JSON ****
        expect(await fetchJson(`${baseUrl}/getNum`, {method: "POST", body: JSON.stringify([123])})).toStrictEqual(123); // Should work even without auto conversion
        expect(await fetchJson(`${baseUrl}/getNum`, {method: "POST", body: JSON.stringify([undefined])})).toStrictEqual(undefined);
        expect(await fetchJson(`${baseUrl}/getBigInt`, {method: "POST", body: JSON.stringify([123])})).toStrictEqual(123n);
        expect(await fetchJson(`${baseUrl}/getBigInt`, {method: "POST", body: JSON.stringify([undefined])})).toStrictEqual(undefined);
        expect(await fetchJson(`${baseUrl}/getDate`, {method: "POST", body: JSON.stringify(date)})).toStrictEqual(date);
        expect(await fetchJson(`${baseUrl}/getDate`, {method: "POST", body: JSON.stringify([undefined])})).toStrictEqual(undefined);


    }, "/api" );
})

test('various call styles', async () => {

    class TheService extends Service {
        static options: ServerSessionOptions = {allowedOrigins: "all"}

        @remote({validateResult: false})
        getBook(name?: string, authorFilter?: string) {
            return [name, authorFilter];
        }

        @remote({trimArguments: true, validateResult: false})
        getBook_trimArguments(name?: string, authorFilter?: string) {
            return [name, authorFilter];
        }

        get3args(a: string, b: string, c: string) {
            return [a,b,c];
        }

        getNoArgs() {
            return "ok"
        }

        getMixed(a: string, b?: string, ...c: string[]) {
            return [a,b,...c];
        }

        postWithBuffer(a: Buffer, b: string, c: string) {
            return [a.toString("utf8"),b,c];
        }

        postWithBuffer2(a: string, b: Buffer, c: string) {
            return [a, b.toString("utf8"),c];
        }

    }


    await runRawFetchTests(new TheService(), async (baseUrl) => {

        async function fetchJson(input: RequestInfo, init?: RequestInit, additionalHeaders: object = {}) {
            const response = await fetch(input, {
                headers: {"Content-Type": "", "accept": "application/brillout-json", ...additionalHeaders}, // Default to unset
                ...init
            });
            // Error handling:
            if (response.status !== 200) {
                throw new Error("server error: " + await response.text())
            }

            return brilloutJsonParse(await response.text());
        }

        expect(await fetchJson(`${baseUrl}/getBook`, {method: "GET"})).toStrictEqual([undefined, undefined]);
        expect(await fetchJson(`${baseUrl}/getBook/a`, {method: "GET"})).toStrictEqual(["a", undefined]); // list arguments in the path
        expect(await fetchJson(`${baseUrl}/getBook?name=a&authorFilter=b`, {method: "GET"})).toStrictEqual(["a", "b"]); // Arguments (named) in the qerystring
        expect(await fetchJson(`${baseUrl}/getBook?name=a&authorFilter=b&csrfProtectionMode=preflight`, {method: "GET"})).toStrictEqual(["a", "b"]); // ... + a meta parameter
        expect(await fetchJson(`${baseUrl}/getBook?a,b`, {method: "GET"})).toStrictEqual(["a", "b"]); // List the arguments (unnamed) in the querystring
        expect(await fetchJson(`${baseUrl}/book/a?authorFilter=b`, {method: "GET"})).toStrictEqual(["a", "b"]);
        expect(await fetchJson(`${baseUrl}/getBook`, {method: "POST"})).toStrictEqual([undefined, undefined]); //
        expect(await fetchJson(`${baseUrl}/getBook`, {method: "POST", body: '{"name": "a"}'})).toStrictEqual(["a", undefined]); //
        expect(await fetchJson(`${baseUrl}/getBook`, {method: "POST", body: '{"name": "a", "csrfProtectionMode": "preflight"}'})).toStrictEqual(["a", undefined]); // ... + a meta parameter
        expect(await fetchJson(`${baseUrl}/getBook`, {method: "POST", body: '["a"]'})).toStrictEqual(["a", undefined]); //


        //expect(await fetchJson(`${baseUrl}/getBook`, {method: "POST", body: '{"name": "a"}'})).toStrictEqual(["a", undefined]); //

        // Combination of the above:
        expect(await fetchJson(`${baseUrl}/getBook?name=fromQuery&authorFilter=b`, {method: "POST", body: '["fromBody"]'})).toStrictEqual(["fromBody", "b"]); //
        expect(await fetchJson(`${baseUrl}/getBook/fromQuery?authorFilter=b`, {method: "POST", body: '["fromBody"]'})).toStrictEqual(["fromQuery","fromBody"]); //
        expect(await fetchJson(`${baseUrl}/getBook/fromQuery?authorFilter=b`, {method: "POST", body: '{"authorFilter": "fromBody"}'})).toStrictEqual(["fromQuery", "fromBody"]); //

        expect(await fetchJson(`${baseUrl}/mixed/a?b,c,d`, {method: "GET"})).toStrictEqual(["a", "b", "c", "d"]); // With rest params

        // Single value in body
        expect(await fetchJson(`${baseUrl}/get3args/a?c=c`, {method: "POST", body: '"b"', headers: {"Content-Type": "application/json"}})).toStrictEqual(["a", "b","c"]); // Json string in body with explicit content type
        expect(await fetchJson(`${baseUrl}/getBook?a`, {method: "POST", body: '"b"'})).toStrictEqual(["a", "b"]); // JSON string sin body
        await expectAsyncFunctionToThrow(async () => {await fetchJson(`${baseUrl}/getBook?a`, {method: "POST", body: 'b'})}); // as plain string - this should not be accepted cause it's too much magic and could lead to unwanted { injections as a security risk
        expect(await fetchJson(`${baseUrl}/getBook?a`, {method: "POST", body: 'b', headers: {"Content-Type": "text/plain"}})).toStrictEqual(["a", "b"]); // Now with text/plain this should work
        expect(await fetchJson(`${baseUrl}/getBook?name=a&authorFilter=b`, {method: "POST", body: '', headers: {"Content-Type": "text/plain"}})).toStrictEqual(["a", "b"]); // Empty body should not cause an error
        expect(await fetchJson(`${baseUrl}/getBook?a,b`, {method: "POST", body: '', headers: {"Content-Type": "text/plain"}})).toStrictEqual(["a", "b"]); // Empty body should not cause an error

        // With Buffer in parameters:
        expect(await fetchJson(`${baseUrl}/withBuffer?b=b&c=c`, {method: "POST", body: 'a'})).toStrictEqual(["a", "b","c"]);
        expect(await fetchJson(`${baseUrl}/withBuffer2/a?c=c`, {method: "POST", body: 'b'})).toStrictEqual(["a", "b","c"]);
        expect(await fetchJson(`${baseUrl}/withBuffer2/a?b=fromQuery&c=c`, {method: "POST", body: 'b'})).toStrictEqual(["a", "b","c"]); // from query should not overwrite

        // Classic form post:
        expect(await fetchJson(`${baseUrl}/getBook`, {method: "POST", body: 'name=a&authorFilter=b', headers: {"Content-Type": "application/x-www-form-urlencoded"}})).toStrictEqual(["a", "b"]);
        expect(await fetchJson(`${baseUrl}/getBook`, {method: "POST", body: 'name=a&authorFilter=b&csrfProtectionMode=preflight', headers: {"Content-Type": "application/x-www-form-urlencoded"}})).toStrictEqual(["a", "b"]); // ... + a meta parameter
        expect(await fetchJson(`${baseUrl}/getBook?authorFilter=fromQuery`, {method: "POST", body: 'name=a&authorFilter=b', headers: {"Content-Type": "application/x-www-form-urlencoded"}})).toStrictEqual(["a", "b"]);
        expect(await fetchJson(`${baseUrl}/getBook?name=a`, {method: "POST", body: 'authorFilter=George%20Orwell', headers: {"Content-Type": "application/x-www-form-urlencoded"}})).toStrictEqual(["a", "George Orwell"]); // mixed


        // Invalid parameters
        await expectAsyncFunctionToThrow(async () => {await fetchJson(`${baseUrl}/getBook?invalidName=test`, {method: "GET"})}, "does not have a parameter");
        await expectAsyncFunctionToThrow(async () => {await fetchJson(`${baseUrl}/mixed/a?b=b&c=c`, {method: "GET"})},/Cannot set .* through named/);


        // Invalid parameters but with trimArguments:
        expect(await fetchJson(`${baseUrl}/getBook_trimArguments?invalidName=test`, {method: "GET"}, {"trimArguments": "true"})).toStrictEqual([undefined, undefined]);
        expect(await fetchJson(`${baseUrl}/getBook_trimArguments?name=myBook&invalidName=test`, {method: "GET"}, {"trimArguments": "true"})).toStrictEqual(["myBook", undefined]);
    }, "/api");
})

test('Result Content-Type', async () => {

    await runRawFetchTests(new class extends Service{
        static options: ServerSessionOptions = {allowedOrigins: "all", logErrors: false, exposeErrors: true}
        async getString() {
            return "test";
        }

        async getHtml() {
            this.call.res!.contentType("text/html; charset=utf-8");
            return "<html/>";
        }

        async getHtmlWithoutExplicitContentType() {
            return "<html/>";
        }


        async getTextPlain() {
            this.call.res!.contentType("text/plain; charset=utf-8");
            return "plain text";
        }

        async returnNonStringAsHtml() {
            this.call.res!.contentType("text/html; charset=utf-8");
            return {};
        }
    }(), async (baseUrl) => {

        async function doFetch(input: RequestInfo, init?: RequestInit) {
            const response = await fetch(input, {
                headers: {"Content-Type": "application/json"},
                method: "GET",
                ...init
            });
            // Error handling:
            if (response.status !== 200) {
                throw new Error("server error: " + await response.text())
            }
            return [await response.text(), response.headers.get("Content-Type")];
        }

        expect(await doFetch(`${baseUrl}/getString`, {})).toStrictEqual(['"test"', "application/json; charset=utf-8"]); // no Accept header set
        await expectAsyncFunctionToThrow(doFetch(`${baseUrl}/getHtmlWithoutExplicitContentType`, {headers: {"Accept": "text/html"}}), "must explicitly set the content type"); // content type was not explicitly specified in getString method but for text/html you have to do so (XSS)
        expect(await doFetch(`${baseUrl}/getHtml`, {})).toStrictEqual(['<html/>', "text/html; charset=utf-8"]); // no Accept header set
        expect(await doFetch(`${baseUrl}/getHtml`, {headers: {"Accept": "text/html"}})).toStrictEqual(['<html/>', "text/html; charset=utf-8"]);
        expect(await doFetch(`${baseUrl}/getHtml`, {headers: {"Accept": "some/thing"}})).toStrictEqual(['<html/>', "text/html; charset=utf-8"]);

        expect(await doFetch(`${baseUrl}/getTextPlain`, {headers: {"Accept": "application/json"}})).toStrictEqual(['plain text', "text/plain; charset=utf-8"]); // text/plain even if accept header was set to json

        await expectAsyncFunctionToThrow(doFetch(`${baseUrl}/returnNonStringAsHtml`, {}), "must return a result of type")

        const chromesAcceptHeader = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"


    }, "/api");
})

test('Http stream and buffer results', async () => {

    await runRawFetchTests(new class extends Service{
        static options: ServerSessionOptions = {allowedOrigins: "all"}
        async readableResult() {
            this.call.res!.contentType("text/plain; charset=utf-8");
            const readable = new Readable({
                read(size: number) {
                }})


            readable.push("test");
            readable.push("test2");
            readable.push(null);
            return readable
        }

        async readableResultWithError() {
            this.call.res!.contentType("text/html; charset=utf-8");
            const readable = new Readable({
                read(size: number) {
                }})

            setTimeout(() => {
                readable.push("test...");
                readable.destroy(new Error("myError"))
            })

            return readable
        }

        async readableResultWithEarlyError() {
            this.call.res!.contentType("text/html; charset=utf-8");
            const readable = new Readable({
                read(size: number) {
                }})


            readable.push("test");
            readable.destroy(new Error("myError"))
            return readable
        }

        async bufferResult() {
            this.call.res!.contentType("text/plain; charset=utf-8");
            return new Buffer("resultöä", "utf8");
        }
    }(), async (baseUrl) => {

        async function doFetch(input: RequestInfo, init?: RequestInit) {
            return new Promise<string>((resolve, reject) => {
                (async () => {

                    const response = await fetch(input, {
                        headers: {"Content-Type": "application/json"},
                        method: "GET",
                        ...init
                    });
                    // Error handling:
                    if (response.status !== 200) {
                        throw new Error("server error: " + await response.text())
                    }
                    return await response.text()
                })().then(resolve, reject);

                setTimeout(() => { reject(new Error("timeout")) }, 1000)
            })

        }

        expect(await doFetch(`${baseUrl}/readableResult`)).toStrictEqual("testtest2");
        //await expectAsyncFunctionToThrow(doFetch(`${baseUrl}/readableResultWithEarlyError`), "myError"); // Commented out because it produces a global unhandled error message. Nontheless this test line works as expected
        expect((await doFetch(`${baseUrl}/readableResultWithError`) ).startsWith("test...Error")).toBeTruthy();

        expect(await doFetch(`${baseUrl}/bufferResult`)).toStrictEqual("resultöä");


    }, "/api");
})

test('FEATURE TODO: Http multipart file uploads', async () => {

    await runRawFetchTests(new class extends Service {
        static options: ServerSessionOptions = {allowedOrigins: "all" , devDisableSecurity: false};
        uploadFile(file_name_0: string, file_name_1: string, upload_file_0: Buffer, upload_file_1: Buffer) {
            return [file_name_0, file_name_1, upload_file_0.toString(), upload_file_1.toString()]
        }

    }(), async (baseUrl) => {

        async function fetchJson(input: RequestInfo, init?: RequestInit) {
            const response = await fetch(input, {
                method: "POST",
                headers: {"Content-Type": "multipart/form-data; boundary=-----------------------------paZqsnEHRufoShdX6fh0lUhXBP4k"}, // Default to unset
                ...init
            });
            // Error handling:
            if (response.status !== 200) {
                throw new Error("server error: " + await response.text())
            }

            return JSON.parse(await response.text());
        }

        const body = ['-----------------------------paZqsnEHRufoShdX6fh0lUhXBP4k',
            'Content-Disposition: form-data; name="file_name_0"',
            '',
            'super alpha file',
            '-----------------------------paZqsnEHRufoShdX6fh0lUhXBP4k',
            'Content-Disposition: form-data; name="file_name_1"',
            '',
            'super beta file',
            '-----------------------------paZqsnEHRufoShdX6fh0lUhXBP4k',
            'Content-Disposition: form-data; '
            + 'name="upload_file_0"; filename="1k_a.dat"',
            'Content-Type: application/octet-stream',
            '',
            'A'.repeat(1023),
            '-----------------------------paZqsnEHRufoShdX6fh0lUhXBP4k',
            'Content-Disposition: form-data; '
            + 'name="upload_file_1"; filename="1k_b.dat"',
            'Content-Type: application/octet-stream',
            '',
            'B'.repeat(1023),
            '-----------------------------paZqsnEHRufoShdX6fh0lUhXBP4k--'
        ].join('\r\n')

        expect(await fetchJson(`${baseUrl}/uploadFile`, {body})).toStrictEqual(['super alpha file', 'super beta file', 'A'.repeat(1023), 'B'.repeat(1023)]);


        // TODO: pause and resume streams
        // TODO: send an incomplete body. Method should complete but (async) stream read events should fail.
        // TODO: files in content body are in diffrent order than parameters. This should set all streams in an error state.
        // TODO: try to pull-read files out of order (in the user method). This should deadlock
    }, "/api");
})

const variousDifferentTypes = ["", null, undefined, true, false, 49, 0, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}, [], [undefined], [1,2,3], "null", "undefined", "0", "true", "false", "[]", "{}", "''", "äö\r\n\uFFC0", "\u0000\uFFFFFF", new Date()];

test('Return types', async () => {
    for(let returnValue of variousDifferentTypes) {
        await runClientServerTests({
                myMethod() {
                    return returnValue;
                },

                myAsyncMethod() {
                    return new Promise((resolve) => resolve(returnValue)); // Make sure this uses promises
                }
            },
            async (apiProxy) => {
                if(returnValue === undefined) {
                    returnValue = null;
                }
                expect(await apiProxy.myMethod()).toStrictEqual(returnValue);
                expect(await apiProxy.myAsyncMethod()).toStrictEqual(returnValue);
            }
        );
    }
});


test('Parameter types', async () => {
    for(let param of variousDifferentTypes) {
        await runClientServerTests({
                myMethod(a,b,c) {
                    expect(a).toStrictEqual(param);
                    expect(b).toBeFalsy();
                    expect(c).toStrictEqual(param);
                },
            },
            async (apiProxy) => {
                await apiProxy.myMethod(param, undefined, param);
            }
        );
    }
});

test('this.call', async () => {
        await new Promise<void>(async (resolve, reject) => {
            try {
                const serverAPI = new class extends Service {
                    async myMethod() {
                        // test access
                        expect(this.call.req!.path).toContain("/myMethod");
                        this.call.res!.setHeader("myHeader", "123"); // test setting headers before the content is sent.
                    }

                    async leakerMethod() {
                        // leak access to this.call.req:
                        setTimeout(() => {
                            expect(() => console.log(this.call.req)).toThrow("Cannot access .call");
                            resolve();
                        });
                    }
                };
                await runClientServerTests(serverAPI,
                    async (apiProxy) => {
                        await apiProxy.myMethod();
                        await apiProxy.leakerMethod();
                    }
                );
            }
            catch (e) {
                reject(e);
            }
    });
});

test('parseQuery', () => {
    class TestSession extends Service{

        // Escalate to 'public'
        public static parseQuery(...args: any) {
            // @ts-ignore
            return super.parseQuery(...args);
        }
    }
    expect(TestSession.parseQuery("book=1984&&author=George%20Orwell&keyWithoutValue").result).toStrictEqual({ book: "1984", author:"George Orwell", keyWithoutValue:"true" })
    expect(TestSession.parseQuery("1984,George%20Orwell").result).toStrictEqual(["1984", "George Orwell"]);
    expect(TestSession.parseQuery("a%20=1&b%20x=2&c%20").result).toStrictEqual({"a ": "1", "b x": "2", "c ": "true"}); // uricomponent encoded keys
    expect(TestSession.parseQuery("a=1&b=2&c").result).toStrictEqual({a: "1", b: "2", "c": "true"});
    expect(TestSession.parseQuery("&c").result).toStrictEqual({"c": "true"});
    expect(TestSession.parseQuery("George%20Orwell").result).toStrictEqual(["George Orwell"]);

});

test('registerIds', () => {
    // TODO
});

test("generateSecret", () => {
    function looksRandomish(buffer: Uint8Array) {
        let lowerBytes = 0;
        buffer.forEach(value => {
            if(value < 128) {
                lowerBytes++;
            }
        })
        return lowerBytes > 2 && lowerBytes < (buffer.length -2)
    }

    {
        const app = restfuncsExpress();
        expect(app.secret.length).toBe(32);
        expect(looksRandomish(app.secret)).toBeTruthy()
    }
    {
        resetGlobalState()
        expect(() => restfuncsExpress({secret: ""})).toThrow("empty string");
        // @ts-ignore
        expect(() => restfuncsExpress({secret: null})).toThrow("Invalid type");
        //expect(() => restfuncsExpress({secret: "1234567"})).toThrow("too short");
        //expect(() => restfuncsExpress({secret: "12345678"})).toThrow("too short"); // A base64 decoded value of this should still be too short
    }
    {
        resetGlobalState()
        const app = restfuncsExpress({secret:"1234567800", sessionValidityTracking: "memory"});
        expect(app.secret.length).toBeGreaterThanOrEqual(8);
    }

});

describe("server 2 server encryption", () => {

    function createRestfuncsExpress(options: ServerOptions) {
        return restfuncsExpress({...options, sessionValidityTracking: "memory"});
    }

    beforeEach(() => {
        resetGlobalState();
    })

    it("It should encrypt+decrypt", () => {
        const app = restfuncsExpress();
        const token = app.server2serverEncryptToken("hallo", "myType");
        expect(app.server2serverDecryptToken(token, "myType")).toBe("hallo")
    });

    it("It should work with different types", () => {
        const app = restfuncsExpress();
        for (const value of variousDifferentTypes) {
            const token = app.server2serverEncryptToken(value, "myType");
            expect(app.server2serverDecryptToken(token, "myType")).toStrictEqual(value)
        }
    });

    it("should fail with the wrong type", () => {
        const app = restfuncsExpress();
        const token = app.server2serverEncryptToken("hallo", "myType");
        expect(() => app.server2serverDecryptToken(token, "myWrongType")).toThrow("wrong type")

    });

    it('should work between 2 different servers', () => {
        const app = createRestfuncsExpress({secret: "test"});
        const token = app.server2serverEncryptToken("hallo", "myType");
        resetGlobalState()
        expect(createRestfuncsExpress({secret: "test"}).server2serverDecryptToken(token, "myType")).toBe("hallo")
    });

    it('should work fail with wrong secret', () => {
        const app = createRestfuncsExpress({secret: "test", sessionValidityTracking: "memory"});
        const token = app.server2serverEncryptToken("hallo", "myType");
        resetGlobalState()
        expect(() => createRestfuncsExpress({secret: "secret2"}).server2serverDecryptToken(token, "myType")).toThrow("decryption failed")
    });

    it('should work fail with wrong nonce', () => {
        const app = createRestfuncsExpress({secret: "test", sessionValidityTracking: "memory"});
        const token = app.server2serverEncryptToken("hallo", "myType");

        expect(() => app.server2serverDecryptToken({...token, nonce: nacl_util.encodeBase64(nacl.randomBytes(24))}, "myType")).toThrow("decryption failed")
    });
});

describe('FAIL ACCEPTED (1) Session fields compatibility - type definitions', () => {
    function checkCompatibility(classes: (typeof ServerSession)[]) {
        [classes, classes.reverse()].forEach(classes => {
            resetGlobalState()
            let app = restfuncsExpress();
            classes.forEach(clazz => app.registerServerSessionClass(clazz));
        })
    }

    test('Various different ServerSession classes', () => {
        {
            class SessionA extends ServerSession {
                myField: string
            }

            class SessionB extends ServerSession {
                myField: any
            }

            expect(() => {
                checkCompatibility([SessionA, SessionB])
            }).toThrow("myField")
        }

        {
            type MyField = { a: string, b: number, c?: object }

            class SessionA extends ServerSession {
                myField: MyField
            }

            class SessionB extends ServerSession {
                myField: MyField
            }

            expect(() => {
                checkCompatibility([SessionA, SessionB])
            }).not.toThrow()
        }

        {
            type MyField = { a: string, b: number, c?: object }

            class SessionA extends ServerSession {
                myField: MyField
            }

            class SessionB extends ServerSession {
                myField: { a: string, b: number, c?: object, d: string } // Additional property d
            }

            expect(() => {
                checkCompatibility([SessionA, SessionB])
            }).toThrow("myField")
        }

        {
            class SessionA extends ServerSession {
                myField: string
                anotherField: string = "123"
            }

            class SessionB extends ServerSession {
                myField: string
            }

            expect(() => {
                checkCompatibility([SessionA, SessionB])
            }).not.toThrow()
        }

    });

    test('FAIL ACCEPTED: With extra optional property', () => {
        type MyField = { a: string, b: number, c?: object }

        class SessionA extends ServerSession {
            myField: MyField
        }

        class SessionC extends ServerSession {
            myField: { a: string, b: number, c?: object, d?: string } // Should be ok, because d is optional
        }

        class SessionB extends ServerSession {
            myField: MyField
        }

        expect(() => {
            checkCompatibility([SessionA, SessionB, SessionC])
        }).not.toThrow()
    });

    test('With array as property', () => {

        class SessionA extends ServerSession {
            myField: string[]
        }

        class SessionB extends ServerSession {
            myField: string[]
        }

        expect(() => {
            checkCompatibility([SessionA, SessionB])
        }).not.toThrow()

    });
});

test('Session change detection', async () => {

    function expectSame(a: object | undefined, b: object | undefined) {
        function removeInternalFields(session?: Partial<CookieSession>) {
            if(!session) {
                return session;
            }

            if(session.id) {
                if(! (session.version && session.bpSalt)) {
                    throw new Error("illegal session state")
                }
                //session.hasInternals = true
            }
            delete session.id
            delete session.version
            delete session.bpSalt
            delete session.previousBpSalt

            return session
        }

        a = removeInternalFields(a);

        function sortKeys(o: object) {
            const result = {};
            Object.keys(o).sort().forEach( k => result[k] = o[k])
            return result;
        }

        if(typeof a !== "object" || typeof b !== "object") {
            expect(a).toStrictEqual(b);
            return;
        }

        expect(JSON.stringify(sortKeys(a))).toBe((JSON).stringify(sortKeys(b)));
    }

    abstract class SessionBase extends ServerSession {
        static async callDoCall_outer(cookieSession: Record<string, unknown>) {
            // @ts-ignore
            return await this.doCall_outer(cookieSession, {}, "myMethod", [], {}, {} );
        }
        abstract myMethod();
    }


    // Test non change:
    {
        class SessionA extends SessionBase {
            myField: string
            @remote()
            myMethod() {

            }
        }
        expect((await SessionA.callDoCall_outer({})).modifiedSession).toBeUndefined()
        expect((await SessionA.callDoCall_outer({a: 1, b: 2, c: {d:3}})).modifiedSession).toBeUndefined();
        // ** Also test with initial values in the prototype - maybe the express session cookie handler delivers its cookie values via prototyped values: **
        expect((await SessionA.callDoCall_outer(Object.create({a: 1, b: 2, c: {d:3}}))).modifiedSession).toBeUndefined(); // With prototype
    }

    /*
    // Non-deterministic fields are actually not allowed, so this would make no sense:
    // Test id:
    let idGenerator = 0;
    {
        class SessionA extends SessionBase {
            myId = ++idGenerator
            otherField=false;
            @remote()
            myMethod() {
                this.otherField=false;
            }
        }

        let actual = (await SessionA.callDoCall_outer({})).modifiedSession;
        expect(actual).toBeDefined();

        // @ts-ignore
        expect(actual.myId == SessionA.referenceInstance).toBeFalsy() // should be different that the reference

        // @ts-ignore
        expect(actual.myId).toBeGreaterThanOrEqual(2);

        expect( (await SessionA.callDoCall_outer({myId: "fromCookie"})).modifiedSession).toBeUndefined() // should not make a change


        expectSame((await SessionA.callDoCall_outer({myId: "fromCookie", otherField:true})).modifiedSession, {myId: "fromCookie", otherField:false}); // Force a change of otherField, by myId should not have increased
    }
    */

    // Setting a field back to its default:
    for(const defaultValue of["default", undefined]) {
        class SessionA extends SessionBase {
            myField = defaultValue;
            @remote()
            myMethod() {
                this.myField = defaultValue;
            }
        }
        expectSame((await SessionA.callDoCall_outer({myField: 123})).modifiedSession,{myField: defaultValue}) // set back to its default
        expect((await SessionA.callDoCall_outer({})).modifiedSession).toBeUndefined() // test this one again (not so important)
    }

    // Setting a field back to its default - deep:
    {
        class SessionA extends SessionBase {
            myField = {deep: "default"};
            @remote()
            myMethod() {
                this.myField.deep = "default";
            }
        }

        const result = await SessionA.callDoCall_outer({myField: {deep: 123}});
        expectSame(result.modifiedSession,{myField: {deep: "default"}}) // set back to its default
        expect((await SessionA.callDoCall_outer({})).modifiedSession).toBeUndefined() // test this one again (not so important)
    }

    // Modify own field
    {
        class SessionA extends SessionBase {
            myField: string
            @remote()
            myMethod() {
                this.myField="modified"
            }
        }
        expectSame((await SessionA.callDoCall_outer({})).modifiedSession,{myField: "modified"})
        expectSame((await SessionA.callDoCall_outer({otherField: 123})).modifiedSession,{myField: "modified", otherField: 123})
        expectSame((await SessionA.callDoCall_outer(Object.create({a: 1, b: 2, c: {d:3}}))).modifiedSession,{a: 1, b: 2, c: {d:3}, myField: "modified"}) // With prototype
    }

    // Default values of own field (no modification)
    {
        class SessionA extends SessionBase {
            myField: string = "default"
            @remote()
            myMethod() {

            }
        }
        expect((await SessionA.callDoCall_outer({})).modifiedSession).toBeUndefined();
        expect((await SessionA.callDoCall_outer({otherField: 123})).modifiedSession).toBeUndefined();
        expect((await SessionA.callDoCall_outer(Object.create({a: 1, b: 2, c: {d:3}}))).modifiedSession).toBeUndefined();
    }

    // Default values with modification
    for(const defaultValue of["default", undefined]) {
        class SessionA extends SessionBase {
            myField?: string = defaultValue
            @remote()
            myMethod() {
                this.myField ="modified"
            }
        }
        expectSame((await SessionA.callDoCall_outer({})).modifiedSession,{myField: "modified"})
        expectSame((await SessionA.callDoCall_outer({otherField: 123})).modifiedSession,{myField: "modified", otherField: 123})
        expectSame((await SessionA.callDoCall_outer(Object.create({a: 1, b: 2, c: {d:3}}))).modifiedSession,{a: 1, b: 2, c: {d:3}, myField: "modified"}) // With prototype
    }

    // Default own values with deep modification
    {
        class SessionA extends SessionBase {
            myField = {inner: "defaultInner"}
            @remote()
            myMethod() {
                this.myField.inner ="modified"
            }
        }
        expectSame((await SessionA.callDoCall_outer({})).modifiedSession,{myField: {inner: "modified"}})
        expectSame((await SessionA.callDoCall_outer({otherField: 123})).modifiedSession,{myField: {inner: "modified"}, otherField: 123})
        expectSame((await SessionA.callDoCall_outer(Object.create({a: 1, b: 2, c: {d:3}}))).modifiedSession,{a: 1, b: 2, c: {d:3}, myField: {inner: "modified"}}) // With prototype
    }


    // Modification of foreign values (of the cookieSession)
    {
        class SessionA extends SessionBase {
            myField = "default"
            @remote()
            myMethod() {
                // @ts-ignore
                this.otherField ="modified"
            }
        }
        expectSame((await SessionA.callDoCall_outer({})).modifiedSession,{myField: "default", otherField: "modified"})
        expectSame((await SessionA.callDoCall_outer({otherField: 123})).modifiedSession,{myField: "default", otherField: "modified"})
        expectSame((await SessionA.callDoCall_outer(Object.create({otherField: 123, a: 1, b: 2, c: {d:3}}))).modifiedSession,{otherField: "modified", a: 1, b: 2, c: {d:3}, myField: "default"}) // With prototype
    }

    // Modification of foreign values (of the cookieSession) - deep
    {
        class SessionA extends SessionBase {
            myField = "default"
            @remote()
            myMethod() {
                // @ts-ignore
                this.otherField.deep ="modified"
            }
        }
        expectSame((await SessionA.callDoCall_outer({otherField: {deep: 123}})).modifiedSession,{myField: "default", otherField: {deep: "modified"}})
        expectSame((await SessionA.callDoCall_outer(Object.create({otherField: {deep: 123}, a: 1, b: 2, c: {d:3}}))).modifiedSession,{otherField: {deep: "modified"}, a: 1, b: 2, c: {d:3}, myField: "default"}) // With prototype
    }


    // Different property order in cookieSession
    {
        class SessionA extends SessionBase {
            a = "a"
            b = undefined
            c = "c"
            @remote()
            myMethod() {

            }
        }
        expect((await SessionA.callDoCall_outer({c:1, a: 2})).modifiedSession).toBeUndefined();
        expect((await SessionA.callDoCall_outer({c:1, b: undefined, a: 2})).modifiedSession).toBeUndefined();
        expect((await SessionA.callDoCall_outer({c:1, a: 2, b: "defined"})).modifiedSession).toBeUndefined();
    }

});

test('Session fields compatibility - actual values', () => {
    function checkCompatibility(classes : (typeof ServerSession)[]) {
        resetGlobalState()
        let app = restfuncsExpress();
        classes.forEach(clazz => app.registerServerSessionClass(clazz)  );
    }

    {
        // Different primitive values:
        class SessionA extends ServerSession {
            myField = "123"
        }
        class SessionB extends ServerSession {
            myField = "456"
        }
        expect(() => { checkCompatibility([SessionA, SessionB])}).toThrow("myField")
    }

    {
        // Also has different type definitions
        class SessionA extends ServerSession {
            myField = "123"
        }
        class SessionB extends ServerSession {
            myField = undefined
        }
        expect(() => { checkCompatibility([SessionA, SessionB])}).toThrow("myField")
    }

    {
        class SessionA extends ServerSession {
            myField? = "123"
        }
        class SessionB extends ServerSession {
            myField?: string = undefined
        }
        expect(() => { checkCompatibility([SessionA, SessionB])}).toThrow("myField")
    }

    {
        class SessionA extends ServerSession {
            myField = {a:1, b:2}
        }
        class SessionB extends ServerSession {
            myField = {a:1, b:2}
        }
        expect(() => { checkCompatibility([SessionA, SessionB])}).not.toThrow()
    }

    {
        // Objects not deeply equal
        class SessionA extends ServerSession {
            myField = {a:1, b:2}
        }
        class SessionB extends ServerSession {
            myField = {a:1, b:3}
        }
        expect(() => { checkCompatibility([SessionA, SessionB])}).toThrow("myField")
    }

    // Non deterministic
    {
        let counterA = 0;
        let counterB = 0;
        // Non deterministic
        class SessionA extends ServerSession {
            myField = counterA++
        }
        class SessionB extends ServerSession {
            myField = counterB++
        }
        expect(() => { checkCompatibility([SessionA, SessionB])}).toThrow("myField")
    }

    // Non deterministic, deep
    {
        let counterA = 0;
        let counterB = 0;
        // Non deterministic
        class SessionA extends ServerSession {
            myField = {deep: counterA++}
        }
        class SessionB extends ServerSession {
            myField = {deep: counterB++}
        }
        expect(() => { checkCompatibility([SessionA, SessionB])}).toThrow("myField")
    }

});

test('diagnosis_looksLikeJson', () => {
    expect(diagnosis_looksLikeJSON("test")).toBeFalsy();
    expect(diagnosis_looksLikeJSON("test123")).toBeFalsy();
    expect(diagnosis_looksLikeJSON('{"prop": true}}')).toBeTruthy();
    expect(diagnosis_looksLikeJSON('[1,2]')).toBeTruthy();
    expect(diagnosis_looksLikeJSON('true')).toBeTruthy();
    expect(diagnosis_looksLikeJSON('-1')).toBeTruthy();
    expect(diagnosis_looksLikeJSON('50')).toBeTruthy();
    expect(diagnosis_looksLikeJSON('null')).toBeTruthy();
    expect(diagnosis_looksLikeJSON('0.523')).toBeTruthy();
});

describe('Reserved names', () => {

    for(const forbiddenName of ["req", "res", "session", "doCall","methodIsSafe"]) {
        test(`with ${forbiddenName}`, async () => {
            class MyService extends ServerSession {

            }
            await runClientServerTests(new MyService(), async apiProxy => {
                await expectAsyncFunctionToThrow(async () => {
                    // @ts-ignore
                    await apiProxy.doCall(forbiddenName)
                }, /You are trying to call a remote method that is a reserved name|No method candidate found|does not have a @remote\(\) decorator/);

            });
        });
    }

    test(`Check that these can't be used if not defined`, async () => {
        await runClientServerTests(new class extends Service {
        }, async apiProxy => {
            for (const forbiddenName of ["get", "set"]) {
                await expectAsyncFunctionToThrow(async () => {
                    await apiProxy[forbiddenName]()
                }, /You are trying to call a remote method that is a reserved name|No method candidate found|does not have a @remote\(\) decorato|Method not found|method that does not exist/);
            }
        });
    });
});

describe('CookieSessions', () => {
    for(const classicExpress of [false, true]) {
        for (const thirdPartySessionHandler of [false, true]) {
            if (classicExpress && !thirdPartySessionHandler) {
                continue; // this combination does not exist
            }
            for (const lazyCookie of [true, false]) {
                if(!lazyCookie && !thirdPartySessionHandler) {
                    continue; // this combination does not exist
                }
                for (const useSocket of [false, true]) {
                    const settings = {useSocket, classicExpress, thirdPartySessionHandler, lazyCookie};
                    test(`Various read/write with ${JSON.stringify(settings)}`, async () => {
                        class MyService extends Service {

                            counter: number |  null = 0
                            val:any = null
                            someObject?: { x: string }
                            someUndefined = undefined;


                            async checkInitialSessionValues() {
                                expect(this.counter).toBe(0);
                                expect(this.val).toBe(null);
                                expect(this.someObject).toStrictEqual(undefined);
                                // @ts-ignore
                                expect(this.undefinedProp).toBe(undefined);

                                // Test the proxy's setter / getter:
                                this.counter = this.counter! + 1;
                                this.counter = this.counter + 1; // Sessions#note1: We don't want to fail here AFTER the first write. See ServerSession.ts -> Sessions#note1
                                expect(this.counter).toBe(2);
                                this.counter = null;
                                expect(this.counter).toBe(null);
                            }

                            async storeValueInSession(value) {
                                this.val = value;
                            }

                            getValueFromSession() {
                                return this.val;
                            }

                            async setSomeObject_x(value: string) {
                                if (this.someObject === undefined) {
                                    this.someObject = {x: value};
                                }
                                this.someObject.x = value;
                            }

                            async getSomeObject_x() {
                                return this.someObject!.x;
                            }
                        }

                        resetGlobalState()
                        const server = createServer(MyService, settings);
                        try {
                            // @ts-ignore
                            const port = server.address().port;
                            const apiProxy = new RestfuncsClient<MyService>(`http://localhost:${port}`, {useSocket}).proxy

                            await apiProxy.checkInitialSessionValues();

                            // Set a value
                            await apiProxy.storeValueInSession(123);
                            expect(await apiProxy.getValueFromSession()).toBe(123);

                            // Set a value to null:
                            await apiProxy.storeValueInSession(null);
                            expect(await apiProxy.getValueFromSession()).toBe(null);

                            await apiProxy.setSomeObject_x("test");
                            expect(await apiProxy.getSomeObject_x()).toBe("test");

                        } finally {
                            // shut down server:
                            server.closeAllConnections();
                            await new Promise((resolve) => server.close(resolve));
                        }
                    })


                    test(`FEATURE TODO: Clearing values with ${JSON.stringify(settings)}`, async () => {
                        let initialValue: string|undefined = undefined;

                        class MyService extends Service {

                            val = initialValue

                            async storeValueInSession(value) {
                                this.val = value;
                            }

                            getValueFromSession() {
                                return this.val;
                            }
                        }

                        resetGlobalState()
                        const server = createServer(MyService, settings);
                        try {
                            // @ts-ignore
                            const port = server.address().port;
                            const apiProxy = new RestfuncsClient<MyService>(`http://localhost:${port}`, {useSocket}).proxy

                            // Set a value to null:
                            initialValue = "initial";
                            await apiProxy.storeValueInSession(null);
                            expect(await apiProxy.getValueFromSession()).toBe(null);

                            // Set a value to null:
                            initialValue = undefined;
                            await apiProxy.storeValueInSession(null);
                            expect(await apiProxy.getValueFromSession()).toBe(null);
                            if (!thirdPartySessionHandler) {
                                // Set a value to undefined
                                initialValue = "initial";
                                await apiProxy.storeValueInSession(undefined);
                                expect(await apiProxy.getValueFromSession()).toBe(undefined); // Does not work with the traditional cookie handler, cause it can't store undefined.
                            }
                        } finally {
                            // shut down server:
                            server.closeAllConnections();
                            await new Promise((resolve) => server.close(resolve));
                        }
                    });

                    test(`Destroy session with ${JSON.stringify(settings)}`, async () => {

                        class MyService extends Service {

                            val = "initial"

                            async storeValueInSession(value) {
                                this.val = value;
                            }

                            getValueFromSession() {
                                return this.val;
                            }

                            @remote({validateResult: false /* RTTI has problems, following types from other modules https://github.com/typescript-rtti/typescript-rtti/issues/113 */})
                            getTheRawCookieSession() {
                                return this.clazz.getFixedCookieSessionFromRequest(this.call.req!);
                            }

                            destroySession() {
                                this.destroy();
                            }

                            getId() {
                                return this.id;
                            }
                        }

                        resetGlobalState()
                        const server = createServer(MyService, settings);
                        try {
                            // @ts-ignore
                            const port = server.address().port;
                            const client = new RestfuncsClient<MyService>(`http://localhost:${port}`, {useSocket});
                            const apiProxy = client.proxy

                            await apiProxy.storeValueInSession("something");
                            expect(await apiProxy.getValueFromSession()).toBe("something");

                            const idBefore = await apiProxy.getId()
                            const before = await client.controlProxy_http.getTheRawCookieSession();

                            await apiProxy.destroySession();
                            if (lazyCookie) {
                                expect(await client.controlProxy_http.getTheRawCookieSession()).toBeUndefined()
                            }
                            expect(await apiProxy.getValueFromSession()).toBe("initial")
                            expect(await apiProxy.getId()).not.toBe(idBefore);

                            // @ts-ignore
                            //const nodeCookie = client._nodeCookie;
                            //expect(Object.keys(nodeCookie).length).toBe(0);

                        } finally {
                            // shut down server:
                            server.closeAllConnections();
                            await new Promise((resolve) => server.close(resolve));
                        }
                    });

                }
            }
        }
    }
});




test('Automatically fetch corsReadToken', async () => {
    class MyService extends ServerSession {
        static options: ServerSessionOptions = {logErrors: false, exposeErrors: true, devDisableSecurity: false}
        logonUser?: string

        @remote()
        logon(user: string) {
            this.logonUser = user;
        }

        @remote()
        getLogonUser() {
            return this.logonUser;
        }

        @remote()
        async test() {
            return "ok";
        }

    }

    resetGlobalState()
    const server = createServer(MyService);
    try {
        // @ts-ignore
        const port = server.address().port;

        // @ts-ignore
        const client = new RestfuncsClient<MyService>(`http://localhost:${port}`, {useSocket: false})
        const allowedService = client.proxy
        await allowedService.logon("bob");
        // @ts-ignore
        const getCurrentToken = () => client._corsReadToken
        // @ts-ignore
        const setCurrentToken = (value) => client._corsReadToken = value
        const validToken = getCurrentToken();
        if (!validToken) {
            let diag_logonUserHttp;
            let diag_logonUser;
            try {
                diag_logonUserHttp = await client.controlProxy_http.getLogonUser();
                diag_logonUser = await client.proxy.getLogonUser();
            }
            catch (e) {}
            throw new Error(`Token has not beet set. logon diag_logonUser: ${diag_logonUser}; diag_logonUserHttp: ${diag_logonUserHttp}`)
        }

        for (const invalidToken of [undefined, `${"AA".repeat(16)}--${"AA".repeat(16)}`]) { // undefined + invalid but well-formed token
            setCurrentToken(invalidToken);
            await allowedService.test();
            expect(getCurrentToken()).toStrictEqual(invalidToken); // Expect it to be unchanged cause no session was accessed
            expect(await allowedService.getLogonUser()).toBe("bob")
            expect(shieldTokenAgainstBREACH_unwrap(<string>getCurrentToken())).toStrictEqual(shieldTokenAgainstBREACH_unwrap(validToken)); // The new token should have been fetched. Assert: getCurrentToken() === valid
        }

    } finally {
        // shut down server:
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }

});

test('TODO getCurrent', async () => {
    await runClientServerTests({}, async proxy => {
        throw new Error("TODO");
    })
});

test('Intercept with doCall (client side)', async () => {
    class MyService extends Service{
        getSomething(something: any) {
            return something;
        }
    }

    class MyClient extends RestfuncsClient<MyService> {

        async doCall(funcName: string, args: any[]) {
            args[0] = "b"
            return await super.doCall(funcName, args) // Call the original function
        }
    }

    const server = createServer(MyService)

    // @ts-ignore
    const port = server.address().port;

    try {
        for(const useSocket of [false, true]) {
            const apiProxy = new MyClient(`http://localhost:${port}`).proxy;
            expect(await apiProxy.getSomething("a")).toBe("b");
        }
    }
    finally {
        // shut down server:
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('Intercept with doFetch (client side)', async () => {

    class MyService extends Service{
        getSomething(something: any) {
            return something;
        }
    }

    // Use with standalone server cause there should be a session handler installed:
    const server = createServer(MyService);

    // @ts-ignore
    const port = server.address().port;

    try {
        class MyRestfuncsClient extends RestfuncsClient<MyService> {
            async doFetch(funcName: string, args: any[], url: string, req: RequestInit) {
                args[0] = "b"; // Mangle
                const r: { result: any, resp: Response } = await super.doFetch(funcName, args, url, req);
                return r
            }
        }

        const apiProxy = new MyRestfuncsClient(`http://localhost:${port}`, {useSocket: false}).proxy;

        expect(await apiProxy.getSomething("a")).toBe("b");
    }
    finally {
        // shut down server:
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('validateCall security', async () => {

   class MyService extends ServerSession {
       static options: ServerSessionOptions = {exposeErrors: true, logErrors: false}
       x = "string";
       @remote()
       myMethod(a,b) {
           return a + b;
       }

       // Make public
       public testValidateCall(evil_methodName: string, evil_args: any[]){
           return super.validateCall(evil_methodName, {argsWithPlaceholders: evil_args}, false);
       }
   }

    const service = new MyService();

    expect(service.testValidateCall("myMethod", ["a","b"])).toBe(undefined); // Should not throw

    // Malformed method name:
    await expectAsyncFunctionToThrow(async () => await service.testValidateCall("validateCall", []),"does not have a @remote() decorator");
    // @ts-ignore
    await expectAsyncFunctionToThrow(async () => await service.testValidateCall(null, []),"methodName not set");
    await expectAsyncFunctionToThrow(async () => await service.testValidateCall("", []),"methodName not set");
    // @ts-ignore
    await expectAsyncFunctionToThrow(async () => await service.testValidateCall({}, []),"not a string");
    await expectAsyncFunctionToThrow(async () => await service.testValidateCall("x", []),"not a function");
    await expectAsyncFunctionToThrow(async () => await service.testValidateCall("nonExistant", []),"does not exist");

    // malformed args:
   // @ts-ignore
    await expectAsyncFunctionToThrow(async () => await service.testValidateCall("myMethod", null),"not an array");
    // @ts-ignore
    await expectAsyncFunctionToThrow(async () => await service.testValidateCall("myMethod", ""),"not an array");
    // @ts-ignore
    await expectAsyncFunctionToThrow(async () => await service.testValidateCall("myMethod", {}),"not an array");
    // Further rtti argschecking is done in runtime-typechecking.test.ts

});

test("Security groups", () => {
    {
        resetGlobalState();
        const server = restfuncsExpress();

        server.registerServerSessionClass(class SessionA extends ServerSession {
        });

        server.registerServerSessionClass(class SessionB extends ServerSession {

        })

        expect(server.getComputed().securityGroups.size).toBe(1);
        expect(server.getComputed().service2SecurityGroupMap.size).toBe(2);
    }

    // Some other option should not affect the result:
    {
        resetGlobalState();
        const server = restfuncsExpress();

        class SessionA extends ServerSession {
            static options: ServerSessionOptions = {
                logErrors:true
            }
        };
        server.registerServerSessionClass(SessionA)

        class SessionB extends ServerSession {
            static options: ServerSessionOptions = {
                logErrors:false
            }
        }
        server.registerServerSessionClass(SessionB)

        expect(server.getComputed().securityGroups.size).toBe(1);
        expect(server.getComputed().service2SecurityGroupMap.size).toBe(2);
    }

    // Same options should place them into the same group
    {
        resetGlobalState();
        const server = restfuncsExpress();
        function isAllowedOrigin() {return true}

        class SessionA extends ServerSession {
            static options: ServerSessionOptions = {
                allowedOrigins: isAllowedOrigin,
                csrfProtectionMode: "csrfToken"
            }
        };
        server.registerServerSessionClass(SessionA)

        class SessionB extends ServerSession {
            static options: ServerSessionOptions = {
                allowedOrigins: isAllowedOrigin,
                csrfProtectionMode: "csrfToken"
            }
        }
        server.registerServerSessionClass(SessionB)

        expect(server.getComputed().securityGroups.size).toBe(1);
        expect(server.getComputed().service2SecurityGroupMap.size).toBe(2);
    }

    // Deep objects (arrays) should also be recognized
    {
        resetGlobalState();
        const server = restfuncsExpress();
        function isAllowedOrigin() {return true}

        class SessionA extends ServerSession {
            static options: ServerSessionOptions = {
                allowedOrigins: ["a","b","c"],
            }
        };
        server.registerServerSessionClass(SessionA)

        class SessionB extends ServerSession {
            static options: ServerSessionOptions = {
                allowedOrigins: ["a","b","c"],
            }
        }
        server.registerServerSessionClass(SessionB)

        expect(server.getComputed().securityGroups.size).toBe(1);
        expect(server.getComputed().service2SecurityGroupMap.size).toBe(2);
    }



    // Different options should place them into different groups
    {
        resetGlobalState();
        const server = restfuncsExpress();
        function isAllowedOrigin() {return true}

        class SessionA extends ServerSession {
            static options: ServerSessionOptions = {
                allowedOrigins: isAllowedOrigin,
                csrfProtectionMode: "preflight"
            }
        };
        server.registerServerSessionClass(SessionA)

        class SessionB extends ServerSession {
            static options: ServerSessionOptions = {
                allowedOrigins: isAllowedOrigin,
                csrfProtectionMode: "csrfToken"
            }
        }
        server.registerServerSessionClass(SessionB)

        const computed = server.getComputed();
        expect(computed.securityGroups.size).toBe(2);
        expect(computed.service2SecurityGroupMap.size).toBe(2);
        expect(computed.service2SecurityGroupMap.get(SessionA) !== computed.service2SecurityGroupMap.get(SessionB)).toBeTruthy()
    }

    // Different allowedOrigin function INSTANCES should place them into different groups
    {
        resetGlobalState();
        const server = restfuncsExpress();
        function isAllowedOrigin() {return true}

        class SessionA extends ServerSession {
            static options: ServerSessionOptions = {
                allowedOrigins: (o) => true,
                csrfProtectionMode: "csrfToken"
            }
        };
        server.registerServerSessionClass(SessionA)

        class SessionB extends ServerSession {
            static options: ServerSessionOptions = {
                allowedOrigins: (o) => true,
                csrfProtectionMode: "csrfToken"
            }
        }
        server.registerServerSessionClass(SessionB)

        const computed = server.getComputed();
        expect(computed.securityGroups.size).toBe(2);
        expect(computed.service2SecurityGroupMap.size).toBe(2);
        expect(computed.service2SecurityGroupMap.get(SessionA) !== computed.service2SecurityGroupMap.get(SessionB)).toBeTruthy()
    }

    // Different options should place them into different groups - devDisableSecurity
    {
        resetGlobalState();
        const server = restfuncsExpress();

        class SessionA extends ServerSession {
            static options: ServerSessionOptions = {
            }
        };
        server.registerServerSessionClass(SessionA)

        class SessionB extends ServerSession {
            static options: ServerSessionOptions = {
                devDisableSecurity: true
            }
        }
        server.registerServerSessionClass(SessionB)

        const computed = server.getComputed();
        expect(computed.securityGroups.size).toBe(2);
        expect(computed.service2SecurityGroupMap.size).toBe(2);
        expect(computed.service2SecurityGroupMap.get(SessionA) !== computed.service2SecurityGroupMap.get(SessionB)).toBeTruthy()
    }

});

test('ClientSocketConnection synchronizations', async () => {
    // Makes sure, different calls know of each other and don't do stuff twice / unnecessary.

    let getHttpSecurityProperties_fetchCounter = 0;
    let getCookieSession_fetchCounter = 0;
    let corsReadTokenFetchCounter = 0;
    class MyServerSession extends Service {
        static options: ServerSessionOptions = {...standardOptions}
        isLoggedIn = false;
        public myMethod() {
            // Access a field to force the fetch of the cors read token
            if(this.isLoggedIn) {
                throw new Error("invalid")
            }
        }

        public getHttpSecurityProperties(...args: any[]) {
            getHttpSecurityProperties_fetchCounter++;
            // @ts-ignore
            return super.getHttpSecurityProperties(...args);
        }

        @remote({validateResult: false /* RTTI has problems, following types from other modules https://github.com/typescript-rtti/typescript-rtti/issues/113 */})
        public getCookieSession(...args: any[]) {
            getCookieSession_fetchCounter++;
            // @ts-ignore
            return super.getCookieSession(...args);

        }

        public getCorsReadToken(): string {
            corsReadTokenFetchCounter++;
            return super.getCorsReadToken();
        }

    }

    resetGlobalState();
    const app = restfuncsExpress();
    app.use("/api", MyServerSession.createExpressHandler());
    const server = app.listen();
    // @ts-ignore
    const serverPort = server.address().port;

    try {
        const client = new RestfuncsClient<MyServerSession>(`http://localhost:${serverPort}/api`,{
            useSocket: true,
            csrfProtectionMode: "corsReadToken"
        });
        try {
            expect(corsReadTokenFetchCounter).toBe(0);

            // Fire off 3 initial requests simultaneously. They should not both fetch stuff in their own. Instead they should see that another one is already fetching it and wait for that.
            const promise1 = client.proxy.myMethod();
            const promise2 = client.proxy.myMethod();
            const promise3 = client.proxy.myMethod();

            await promise1;
            expect(getCookieSession_fetchCounter).toBe(1);
            //expect(corsReadTokenFetchCounter).toBe(1); <- removed check: no corsReadToken needed

            await promise2
            expect(getCookieSession_fetchCounter).toBe(1);
            //expect(corsReadTokenFetchCounter).toBe(1); // Should still be one. <- removed check: no corsReadToken needed

            await promise3
            expect(getCookieSession_fetchCounter).toBe(1);
            //expect(corsReadTokenFetchCounter).toBe(1); // Should still be one <- removed check: no corsReadToken needed
            expect(getHttpSecurityProperties_fetchCounter).toBeLessThan(3)

            // @ts-ignore
            let clientSocketConnection = await client.getClientSocketConnection();
            // @ts-ignore
            expect(clientSocketConnection.methodCallPromises.size).toBe(0) // Expect no open promises
        }
        finally {
            await client.close();
        }
    }
    finally {
        // shut down server
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('TODO socket_requireAccessProofForIndividualServerSession option', async () => {
    throw new Error("TODO")
});

test('Client - error handling with concurrent calls', async () => {
    let counter = 0
    class SessionA extends Service {
        getWelcomeInfo(): WelcomeInfo {
            throw new Error(`welcome info error ${counter++}`)
        }

        myMethod() {
        }
    }

    await runClientServerTests(new SessionA,
        async (apiProxy) => {

            // Start 2 calls at once
            const call1 = apiProxy.myMethod();
            const call2 = apiProxy.myMethod();

            // Except call2 to wait for call1's initialization (and not do an own) so get the same error
            await expect(call1).rejects.toThrow("welcome info error 0");
            await expect(call2).rejects.toThrow("welcome info error 0");

            await expect(apiProxy.myMethod()).rejects.toThrow("welcome info error 1"); // This should try everything again and get a fresh error

        }, {useSocket: true}
    );
});

test('TODO: ClientConnection - error handling with concurrent calls', async () => {
    throw new Error("TODO")
});

it('should close all ClientSocketConnections after client.close()', async () => {
    class MyService extends Service {
        myMethod() {}
    }

    const server = createServer(MyService);
    try {
        // @ts-ignore
        const port = server.address().port;
        const client1 = new RestfuncsClient<MyService>(`http://localhost:${port}`, {useSocket: true, shareSocketConnections: true})
        const client2 = new RestfuncsClient<MyService>(`http://localhost:${port}`, {useSocket: true, shareSocketConnections: true})

        await client1.proxy.myMethod()
        await client2.proxy.myMethod()

        expect((await ClientSocketConnection.getAllOpenSharedConnections()).length).toBe(1)

        await client1.close()
        expect((await ClientSocketConnection.getAllOpenSharedConnections()).length).toBe(1)

        await client2.close()
        expect((await ClientSocketConnection.getAllOpenSharedConnections()).length).toBe(0)

    } finally {
        // shut down server:
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});


describe("Server#isSecurityDisabled", () => {
   it("security should not be disabled even in NODE_ENV=development when at least one serversession does not want so (critical)", () => {
       const orig_NODE_ENV = process.env.NODE_ENV;
       process.env.NODE_ENV = "development";
       try {
           class ServerSessionA extends ServerSession {

           }

           class ServerSessionB extends ServerSession {
           }
           ServerSessionB.options = {devDisableSecurity: false}
           const app = restfuncsExpress({});
           app.use("/a", ServerSessionA.createExpressHandler());
           app.use("/b", ServerSessionB.createExpressHandler());
           expect(app.isSecurityDisabled()).toBe(false);
       }
       finally {
           process.env.NODE_ENV = orig_NODE_ENV;
       }

   })

    it("security should be disabled in NODE_ENV=development when no ServerSession class specifies it explicitly otherwise", () => {
        const orig_NODE_ENV = process.env.NODE_ENV;
        process.env.NODE_ENV = "development";
        try {
            class ServerSessionA extends ServerSession {

            }

            class ServerSessionB extends ServerSession {
            }
            const app = restfuncsExpress({});
            app.use("/a", ServerSessionA.createExpressHandler());
            app.use("/b", ServerSessionB.createExpressHandler());
            expect(app.isSecurityDisabled()).toBe(true);
        }
        finally {
            process.env.NODE_ENV = orig_NODE_ENV;
        }

    })
});

it('should reopen failed ClientSocketConnections', async () => {
    class MyService extends Service {
        myMethod() {}

        failConnection() {
            this.call.socketConnection!.failFatal(new Error("test"));
        }
    }

    const server = createServer(MyService);
    try {
        // @ts-ignore
        const port = server.address().port;
        const client1 = new RestfuncsClient<MyService>(`http://localhost:${port}`, {useSocket: true, shareSocketConnections: true})
        const client2 = new RestfuncsClient<MyService>(`http://localhost:${port}`, {useSocket: true, shareSocketConnections: true})

        await client1.proxy.myMethod()
        await client2.proxy.myMethod()

        await expectAsyncFunctionToThrow(async () => await client1.proxy.failConnection());
        // Should work again
        await client1.proxy.myMethod()
        await client2.proxy.myMethod()

    } finally {
        // shut down server:
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

describe("callbacks", () => {
    let rememberedFunction:() => void | undefined;
    class ServerAPI extends ServerSession {
        @remote()
        callVoidCallback3Times(callback: ()=>void) {
            callback();
            callback();
            callback();
        }

        @remote()
        async callVoidPromiseCallback3Times(callback: ()=> Promise<void>) {
            await callback();
            await callback();
            await callback();
        }

        @remote()
        async callPromiseStringCallback(callback: ()=> Promise<string>) {
            return await callback();
        }

        @remote()
        async deepCallback(a: string, b: {deepProp: ()=> Promise<string>}) {
            return await b.deepProp();
        }
        @remote()
        setRemembered(callback: () => void) {
            rememberedFunction = callback
        }

        @remote()
        isRemembered(callback: () => void) {
            if(rememberedFunction === undefined) {
                throw new Error("Illegal state")
            }
            return rememberedFunction  === callback;
        }
    }

    it("should give usefull error message when used with non- socket connection", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        const mock = jest.fn().mockResolvedValue("hello from client");
        await expectAsyncFunctionToThrow(async () => apiProxy.deepCallback("123", {deepProp: mock}), /deepProp.*socket/);
    }, {
        useSocket: false
    }));

    test("same function instances on the client should lead to same instances on the server", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        function myCallback() {

        }
        await apiProxy.setRemembered(myCallback);
        expect(await apiProxy.isRemembered(myCallback)).toBeTruthy();
        expect(await apiProxy.isRemembered(()=> {})).toBeFalsy();

    }, {
        useSocket: true
    }));

    test("Callback with Promise<void>", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        const mock = jest.fn();
        await apiProxy.callVoidPromiseCallback3Times(mock);
        expect(mock).toBeCalledTimes(3);
    }, {
        useSocket: true
    }));

    test("Callback with Promise<string>", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        const mock = jest.fn().mockResolvedValue("hello from client");
        expect(await apiProxy.callPromiseStringCallback(mock)).toBe("hello from client");
    }, {
        useSocket: true
    }));

    test("Properly retrieve error from a callback with result promise", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        const clientFn = async () => {
            throw new Error("Some error on the client");
        }
        try {
            async function callFromClient() { // Give this stack element a name "callFromClient", so we have it in the error message
                await apiProxy.callPromiseStringCallback(clientFn as any);
            }
            await callFromClient();
            fail("function did not throw an error");
        }
        catch (e) {
            // Check, that the error has all the helpful components in the description / stack:
            expect(e instanceof ServerError).toBeTruthy();
            expect((e as ServerError).message).toMatch(/DownCallError.*Error.*Some error on the client.*clientFn.*callPromiseStringCallback.*/s);
            expect(e.stack).toMatch(/.*callFromClient.*/s)
        }
    }, {
        useSocket: true
    }));

})
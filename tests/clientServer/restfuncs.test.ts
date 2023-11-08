import {ServerSessionOptions, ServerSession as ServerSession} from "restfuncs-server";
import express from "express";
import {ClientProxy, RestfuncsClient} from "restfuncs-client";
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import {Readable} from "node:stream";
import {diagnosis_looksLikeJSON, extendPropsAndFunctions, shieldTokenAgainstBREACH_unwrap} from "restfuncs-server/Util";
import {CommunicationError} from "restfuncs-server/CommunicationError";
import crypto from "node:crypto";
import _ from "underscore";
import session from "express-session";
import {develop_resetGlobals, restfuncsExpress, ServerOptions} from "restfuncs-server/Server";
import {CookieSession, ServerPrivateBox, WelcomeInfo} from "restfuncs-common";
import nacl from "tweetnacl";
import nacl_util from "tweetnacl-util";
import {remote} from "restfuncs-server/ServerSession";

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible

function resetGlobalState() {
    develop_resetGlobals();
    restfuncsClientCookie = undefined;
}


const standardOptions = { checkArguments: false, logErrors: false, exposeErrors: true }


export class Service extends ServerSession {
    static options: ServerSessionOptions = standardOptions;

    // Hack: To lazy to mark all methods with @remote()
    protected static getOwnRemoteMethodOptions(methodName: string) {
        return super.getOwnRemoteMethodOptions(methodName) || {}
    }
}

beforeEach(() => {
    resetGlobalState();
});;


type runClientServerTests_Options = {
    path?: string,
    /**
     * Default: test both, with engine.io sockets and without
     */
    useSocket?: boolean
}

export async function runClientServerTests<Api extends object>(serverAPI: Api, clientTests: (proxy: ClientProxy<Api>) => void, param_testOptions: runClientServerTests_Options = {}) {
    if(param_testOptions.useSocket === undefined) {
        await inner(false); // Without engine.io sockets
        await inner(true); // With engine.io sockets
    }
    else {
        await inner(param_testOptions.useSocket); // With engine.io sockets
    }

    async function inner(useSockets: boolean) {
        resetGlobalState();

        const testOptions: runClientServerTests_Options = {
            path: "/api",
            ...param_testOptions
        }


        const app = restfuncsExpress();
        const service = toServiceClass(serverAPI);
        service.options = {...standardOptions, ...service.options}
        app.use(testOptions.path, service.createExpressHandler());
        const server = app.listen();
        // @ts-ignore
        const serverPort = server.address().port;

        try {
            const client = new RestfuncsClient_fixed<Api & Service>(`http://localhost:${serverPort}${testOptions.path}`,{
                useSocket: useSockets
            });
            try {
                await clientTests(client.proxy);
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
    }
}

function toServiceClass<Api>(serverAPI: Api) : typeof ServerSession {

    if (serverAPI instanceof ServerSession) {
        return serverAPI.clazz;
    } else {
        class ServiceWithTypeInfo extends Service { // Plain ServerSession was not compiled with type info but this file is
        }
        extendPropsAndFunctions(ServiceWithTypeInfo.prototype, serverAPI);

        if(Object.getPrototypeOf(Object.getPrototypeOf(serverAPI))?.constructor) {
            throw new Error("ServerAPI should not be a class without beeing a ServerSession");
        }

        // @ts-ignore
        return ServiceWithTypeInfo;
    }
}

async function runRawFetchTests<Api extends object>(serverAPI: Api, rawFetchTests: (baseUrl: string) => void, path = "/api", options?: Partial<ServerSessionOptions>) {
    resetGlobalState();

    const app = restfuncsExpress();
    let serviceClass = toServiceClass(serverAPI);
    serviceClass.options = {checkArguments: false, logErrors: false, exposeErrors: true, ...serviceClass.options} // Not the clean way. It should all go through the constructor. TODO: improve it for all the callers
    app.use(path, serviceClass.createExpressHandler());
    const server = app.listen();
    // @ts-ignore
    const serverPort = server.address().port;

    try {
        await rawFetchTests(`http://localhost:${serverPort}${path}`);
    }
    finally {
        // shut down server
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

function createServer(serviceClass: typeof Service) {
    const app = restfuncsExpress();

    app.use("/", serviceClass.createExpressHandler());
    return app.listen(0);
}

/**
 * Cookie that's used by restfuncsClient_fixed.
 */
let restfuncsClientCookie:string;

/**
 * Implements a cookie, cause the current nodejs implementations lacks of support for it.
 */
class RestfuncsClient_fixed<S extends Service> extends RestfuncsClient<S> {
    async httpFetch(url: string, request: RequestInit) {
        const result = await super.httpFetch(url, {
            ...request,
            headers: {...(request.headers || {}), "Cookie": restfuncsClientCookie}
        });
        const setCookie = result.headers.get("Set-Cookie");
        if (setCookie) {
            restfuncsClientCookie = setCookie;
        }
        return result;
    }
}

async function expectAsyncFunctionToThrow(f: ((...any) => any) | Promise<any>, expected?: string | RegExp | Error | jest.Constructable) {
    let caught = null;
    try {
        if(typeof f === "function") {
            await f();
        }
        else {
            await f;
        }
    }
    catch (e) {
        caught = e;
    }

    expect( () => {
        if(caught) {
            throw caught;
        }
    }).toThrow(expected);
}

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

        const greeterService = new RestfuncsClient_fixed<GreeterService>(`http://localhost:${serverPort}/greeterAPI`).proxy
        expect(await greeterService.greet("Bob")).toBe("hello Bob from the server");
    }
    finally {
        // shut down server
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('Non restfuncsExpress server with own session handler', async () => {
    class GreeterService extends Service {
        someValue?: string
        greet(name: string) {
            return `hello ${name} from the server`
        }
        writeSession() {
            this.someValue = "123";
        }
        readSession() {
            return this.someValue;
        }
    }


    const app = express();

    // Install session handler:
    app.use(session({
        secret: crypto.randomBytes(32).toString("hex"),
        cookie: {sameSite: false}, // sameSite is not required for restfuncs's security but you could still enable it to harden security, if you really have no cross-site interaction.
        saveUninitialized: false, // Privacy: Only send a cookie when really needed
        unset: "destroy",
        store: undefined, // Defaults to MemoryStore. You may use a better one for production to prevent against growing memory by a DOS attack. See https://www.npmjs.com/package/express-session
        resave: false
    }));

    app.use("/greeterAPI", GreeterService.createExpressHandler());
    const server = app.listen();

    try {
        // @ts-ignore
        const serverPort = server.address().port;

        const greeterService = new RestfuncsClient_fixed<GreeterService>(`http://localhost:${serverPort}/greeterAPI`).proxy
        expect(await greeterService.greet("Bob")).toBe("hello Bob from the server");
        await greeterService.writeSession();
        expect(await greeterService.readSession()).toBe("123");
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

        const greeterService = new RestfuncsClient_fixed<GreeterService>(`http://localhost:${serverPort}/greeterAPI`).proxy
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
            const client = new RestfuncsClient_fixed(`http://localhost:${63000}/apiXY`).proxy; // Connect to server port that does not yet exist


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
    class BaseService extends Service{
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
        static options = {checkArguments: true}
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

        getBook(name?: string, authorFilter?: string) {
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

        async function fetchJson(input: RequestInfo, init?: RequestInit) {
            const response = await fetch(input, {
                headers: {"Content-Type": ""}, // Default to unset
                ...init
            });
            // Error handling:
            if (response.status !== 200) {
                throw new Error("server error: " + await response.text())
            }

            return JSON.parse(await response.text());
        }

        expect(await fetchJson(`${baseUrl}/getBook`, {method: "GET"})).toStrictEqual([null, null]);
        expect(await fetchJson(`${baseUrl}/getBook/a`, {method: "GET"})).toStrictEqual(["a", null]); // list arguments in the path
        expect(await fetchJson(`${baseUrl}/getBook?name=a&authorFilter=b`, {method: "GET"})).toStrictEqual(["a", "b"]); // Arguments (named) in the qerystring
        expect(await fetchJson(`${baseUrl}/getBook?name=a&authorFilter=b&csrfProtectionMode=preflight`, {method: "GET"})).toStrictEqual(["a", "b"]); // ... + a meta parameter
        expect(await fetchJson(`${baseUrl}/getBook?a,b`, {method: "GET"})).toStrictEqual(["a", "b"]); // List the arguments (unnamed) in the querystring
        expect(await fetchJson(`${baseUrl}/book/a?authorFilter=b`, {method: "GET"})).toStrictEqual(["a", "b"]);
        expect(await fetchJson(`${baseUrl}/getBook`, {method: "POST"})).toStrictEqual([null, null]); //
        expect(await fetchJson(`${baseUrl}/getBook`, {method: "POST", body: '{"name": "a"}'})).toStrictEqual(["a", null]); //
        expect(await fetchJson(`${baseUrl}/getBook`, {method: "POST", body: '{"name": "a", "csrfProtectionMode": "preflight"}'})).toStrictEqual(["a", null]); // ... + a meta parameter
        expect(await fetchJson(`${baseUrl}/getBook`, {method: "POST", body: '["a"]'})).toStrictEqual(["a", null]); //


        //expect(await fetchJson(`${baseUrl}/getBook`, {method: "POST", body: '{"name": "a"}'})).toStrictEqual(["a", null]); //

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
        await expectAsyncFunctionToThrow(async () => {await fetchJson(`${baseUrl}/getBook?invalidName=test`, {method: "GET"})}, "does not have a parameter");
        await expectAsyncFunctionToThrow(async () => {await fetchJson(`${baseUrl}/mixed/a?b=b&c=c`, {method: "GET"})},/Cannot set .* through named/);
    }, "/api");
})

test('Result Content-Type', async () => {

    await runRawFetchTests(new class extends Service{
        static options: ServerSessionOptions = {allowedOrigins: "all", logErrors: false, exposeErrors: true}
        async getString() {
            return "test";
        }

        async getHtml() {
            this.res.contentType("text/html; charset=utf-8");
            return "<html/>";
        }

        async getHtmlWithoutExplicitContentType() {
            return "<html/>";
        }


        async getTextPlain() {
            this.res.contentType("text/plain; charset=utf-8");
            return "plain text";
        }

        async returnNonStringAsHtml() {
            this.res.contentType("text/html; charset=utf-8");
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
            this.res.contentType("text/plain; charset=utf-8");
            const readable = new Readable({
                read(size: number) {
                }})


            readable.push("test");
            readable.push("test2");
            readable.push(null);
            return readable
        }

        async readableResultWithError() {
            this.res.contentType("text/html; charset=utf-8");
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
            this.res.contentType("text/html; charset=utf-8");
            const readable = new Readable({
                read(size: number) {
                }})


            readable.push("test");
            readable.destroy(new Error("myError"))
            return readable
        }

        async bufferResult() {
            this.res.contentType("text/plain; charset=utf-8");
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

test('Http multipart file uploads', async () => {

    await runRawFetchTests(new class extends Service {
        static options: ServerSessionOptions = {allowedOrigins: "all" , checkArguments: true};
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

test('.req, .res and Resources leaks', async () => {
        await new Promise<void>(async (resolve, reject) => {
            try {
                const serverAPI = new class extends Service {
                    async myMethod() {
                        // test ac
                        expect(this.req.path).toContain("/myMethod");
                        this.res.setHeader("myHeader", "123"); // test setting headers before the content is sent.
                    }

                    async leakerMethod() {
                        // leak access to this.req:
                        setTimeout(() => {
                            expect(() => console.log(this.req)).toThrow("Cannot access .req");
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
        static options = {checkArguments: false}

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

test('Session fields compatibility - type definitions', () => {
    function checkCompatibility(classes : (typeof ServerSession)[]) {
        let app = restfuncsExpress();
        classes.forEach(clazz => app.registerServerSessionClass(clazz)  );
    }

    {
        class SessionA extends ServerSession {
            myField: string
        }
        class SessionB extends ServerSession {
            myField: any
        }
        expect(() => { checkCompatibility([SessionA, SessionB])}).toThrow("myField")
    }

    {
        type MyField = {a: string, b: number, c?: object}
        class SessionA extends ServerSession {
            myField: MyField
        }
        class SessionB extends ServerSession {
            myField: MyField
        }
        expect(() => { checkCompatibility([SessionA, SessionB])}).toReturn()
    }

    {
        type MyField = {a: string, b: number, c?: object}
        class SessionA extends ServerSession {
            myField: MyField
        }
        class SessionB extends ServerSession {
            myField: {a: string, b: number, c?: object, d: string} // Additional property d
        }
        expect(() => { checkCompatibility([SessionA, SessionB])}).toThrow("myField")
    }

    {
        type MyField = {a: string, b: number, c?: object}
        class SessionA extends ServerSession {
            myField: MyField
        }
        class SessionC extends ServerSession {
            myField: {a: string, b: number, c?: object, d?: string} // Should be ok, because d is optional
        }
        class SessionB extends ServerSession {
            myField: MyField
        }
        expect(() => { checkCompatibility([SessionA, SessionB, SessionC])}).toReturn()
    }

    {
        class SessionA extends ServerSession {
            myField: string
            anotherField: string = "123"
        }
        class SessionB extends ServerSession {
            myField: string
        }
        expect(() => { checkCompatibility([SessionA, SessionB])}).toReturn()
    }

});

test('Session change detection', async () => {

    function expectSame(a: object, b: object) {
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
            myMethod() {

            }
        }
        expect((await SessionA.callDoCall_outer({})).modifiedSession).toBeUndefined()
        expect((await SessionA.callDoCall_outer({a: 1, b: 2, c: {d:3}})).modifiedSession).toBeUndefined();
        // ** Also test with initial values in the prototype - maybe the express session cookie handler delivers its cookie values via prototyped values: **
        expect((await SessionA.callDoCall_outer(Object.create({a: 1, b: 2, c: {d:3}}))).modifiedSession).toBeUndefined(); // With prototype
    }

    // Test id:
    let idGenerator = 0;
    {
        class SessionA extends SessionBase {
            myId = ++idGenerator
            otherField=false;
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

    // Setting a field back to its default:
    for(const defaultValue of["default", undefined]) {
        class SessionA extends SessionBase {
            myField = defaultValue;
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
            myField = undefined
        }
        expect(() => { checkCompatibility([SessionA, SessionB])}).toReturn()
    }

    {
        class SessionA extends ServerSession {
            myField = {a:1, b:2}
        }
        class SessionB extends ServerSession {
            myField = {a:1, b:2}
        }
        expect(() => { checkCompatibility([SessionA, SessionB])}).toReturn()
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

test('Reserved names', async () => {
    await runClientServerTests(new class extends Service{

    },async apiProxy => {
        for(const forbiddenName of ["req", "res", "session", "doCall","methodIsSafe"]) {
            // @ts-ignore
            await expectAsyncFunctionToThrow(async () => {await apiProxy.doCall(forbiddenName)}, /You are trying to call a remote method that is a reserved name|No method candidate found/);
        }

        // Check that these can't be used if not defined:
        for(const forbiddenName of ["get", "set"]) {
            // @ts-ignore
            await expectAsyncFunctionToThrow(async () => {await apiProxy.doCall(forbiddenName)}, /You are trying to call a remote method that is a reserved name|No method candidate found/);
        }
    });
});

test('Sessions', async () => {
    class MyService extends Service{

            counter= 0
            val= null
            someObject?: {x:number}
        someUndefined = undefined;


        async checkInitialSessionValues() {
            expect(this.counter).toBe(0);
            expect(this.val).toBe(null);
            expect(this.someObject).toStrictEqual(undefined);
            // @ts-ignore
            expect(this.undefinedProp).toBe(undefined);

            // Test the proxy's setter / getter:
            this.counter = this.counter + 1;
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

        async setSomeObject_x(value) {
            if(this.someObject === undefined) {
                this.someObject = {x:value};
            }
            this.someObject.x = value;
        }

        async getSomeObject_x() {
            return this.someObject.x;
        }
    }

    for(const useSocket of [false, true]) {
        resetGlobalState()
        const server = createServer(MyService);
        try {
            // @ts-ignore
            const port = server.address().port;
            const apiProxy = new RestfuncsClient_fixed<MyService>(`http://localhost:${port}`, {useSocket}).proxy

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
    }
});

test('Sessions - clearing values', async () => {
    let initialValue = undefined;
    class MyService extends Service{

        val= initialValue

        async storeValueInSession(value) {
            this.val = value;
        }

        getValueFromSession() {
            return this.val;
        }
    }

    for(const useSocket of [false, true]) {
        resetGlobalState()
        const server = createServer(MyService);
        try {
            // @ts-ignore
            const port = server.address().port;
            const apiProxy = new RestfuncsClient_fixed<MyService>(`http://localhost:${port}`, {useSocket}).proxy

            // Set a value to null:
            initialValue = "initial";
            await apiProxy.storeValueInSession(null);
            expect(await apiProxy.getValueFromSession()).toBe(null);

            // Set a value to null:
            initialValue = undefined;
            await apiProxy.storeValueInSession(null);
            expect(await apiProxy.getValueFromSession()).toBe(null);

            // Set a value to undefined
            initialValue = "initial";
            await apiProxy.storeValueInSession(undefined);
            expect(await apiProxy.getValueFromSession()).toBe(undefined);
        } finally {
            // shut down server:
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    }
});

test('Automatically fetch corsReadToken', async () => {
    class MyService extends Service{
        logonUser?: string

        logon(user: string) {
            this.logonUser = user;
        }

        getLogonUser() {
            return this.logonUser;
        }

        async test() {
            return "ok";
        }

    }
    for(const useSocket of [false, true]) {
        resetGlobalState()
        const server = createServer(MyService);
        try {
            // @ts-ignore
            const port = server.address().port;

            // @ts-ignore
            const client = new RestfuncsClient_fixed<MyService>(`http://localhost:${port}`, {useSocket})
            const allowedService = client.proxy
            await allowedService.logon("bob");
            // @ts-ignore
            const getCurrentToken = () => client._corsReadToken
            // @ts-ignore
            const setCurrentToken = (value) => client._corsReadToken = value
            const validToken = getCurrentToken();
            if (!validToken) {
                throw new Error("Token has not beet set")
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
    }
});

test('getCurrent', async () => {
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

    class MyClient extends RestfuncsClient_fixed<MyService> {

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

   const service: Service & {validateCall: Service["validateCall"] /* make the method public */} = new class extends Service {
       x = "string";
       myMethod(a,b) {
           return a + b;
       }

       public validateCall(evil_methodName: string, evil_args: any[]){
           return super.validateCall(evil_methodName, evil_args);
       }
   }



    expect(service.validateCall("myMethod", ["a","b"])).toBe(undefined); // Should not throw

    // Malformed method name:
    await expectAsyncFunctionToThrow(async () => await service.validateCall("validateCall", []),"reserved name");
    await expectAsyncFunctionToThrow(async () => await service.validateCall(null, []),"methodName not set");
    await expectAsyncFunctionToThrow(async () => await service.validateCall("", []),"methodName not set");
    // @ts-ignore
    await expectAsyncFunctionToThrow(async () => await service.validateCall({}, []),"not a string");
    await expectAsyncFunctionToThrow(async () => await service.validateCall("x", []),"not a function");
    await expectAsyncFunctionToThrow(async () => await service.validateCall("nonExistant", []),"does not exist");

    // malformed args:
   await expectAsyncFunctionToThrow(async () => await service.validateCall("myMethod", null),"not an array");
    // @ts-ignore
    await expectAsyncFunctionToThrow(async () => await service.validateCall("myMethod", ""),"not an array");
    // @ts-ignore
    await expectAsyncFunctionToThrow(async () => await service.validateCall("myMethod", {}),"not an array");
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
        const client = new RestfuncsClient_fixed<MyServerSession>(`http://localhost:${serverPort}/api`,{
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
            expect(corsReadTokenFetchCounter).toBe(1);

            await promise2
            expect(getCookieSession_fetchCounter).toBe(1);
            expect(corsReadTokenFetchCounter).toBe(1); // Should still be one

            await promise3
            expect(getCookieSession_fetchCounter).toBe(1);
            expect(corsReadTokenFetchCounter).toBe(1); // Should still be one
            expect(getHttpSecurityProperties_fetchCounter).toBeLessThan(3)

            // @ts-ignore
            expect(client.preparedSocketConnection.conn.methodCallPromises.size).toBe(0) // Expect no open promises
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

test('socket_requireAccessProofForIndividualServerSession option', async () => {
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

test('ClientConnection - error handling with concurrent calls', async () => {


    throw new Error("TODO")
});


test('listCallableMethods', () => {
   class A extends Service {
       async methodA() {}
       async methodB(x: string) {}
   }

   const a = new A;
   expect(A.listCallableMethods().length).toBe(2);
   expect(A.listCallableMethods()[0].name).toBe("methodA");
});

test('mayNeedFileUploadSupport', () => {
    class Service1 extends Service {
        async methodA() {}
        async methodB(x: string) {}
        async methodC(x: any) {}
        async methodD(x: string | number) {}
    }
    expect(Service1.mayNeedFileUploadSupport()).toBeFalsy()

    class Service2 extends Service {
        async methodA(b: Buffer) {}
    }
    expect(Service2.mayNeedFileUploadSupport()).toBeTruthy()

    class Service3 extends Service {
        async methodA(...b: Buffer[]) {}
    }
    expect(Service3.mayNeedFileUploadSupport()).toBeTruthy()

});
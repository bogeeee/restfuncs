import {ServerSessionOptions, safe, ServerSession as ServerSession} from "restfuncs-server";
import express from "express";
import {ClientProxy, RestfuncsClient} from "restfuncs-client";
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import {Readable} from "node:stream";
import {diagnosis_looksLikeJSON, extendPropsAndFunctions, shieldTokenAgainstBREACH_unwrap} from "restfuncs-server/Util";
import {RestError} from "restfuncs-server/RestError";
import crypto from "node:crypto";
import _ from "underscore";
import session from "express-session";
import {develop_resetGlobals, restfuncsExpress} from "./server/Server";

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible

function resetGlobalState() {
    develop_resetGlobals();
    restfuncsClientCookie = undefined;
}


const standardOptions = { checkArguments: false, logErrors: false, exposeErrors: true }


class Service extends ServerSession {
    static options: ServerSessionOptions = standardOptions;
}

beforeEach(() => {
    resetGlobalState();
});;
async function runClientServerTests<Api extends object>(serverAPI: Api, clientTests: (proxy: ClientProxy<Api>) => void, path = "/api") {
    resetGlobalState();

    const app = express();
    const service = toServiceClass(serverAPI);
    service.options = {...standardOptions, ...service.options}
    app.use(path, service.createExpressHandler());
    const server = app.listen();
    // @ts-ignore
    const serverPort = server.address().port;

    try {
        const client = new RestfuncsClient_fixed<Api>(`http://localhost:${serverPort}${path}`).proxy;
        await clientTests(client);
    }
    finally {
        // shut down server
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

function toServiceClass<Api>(serverAPI: Api) : typeof Service {

    if (serverAPI instanceof Service) {
        return serverAPI.clazz;
    } else {
        class ServiceWithTypeInfo extends Service { // Plain ServerSession was not compiled with type info but this file is
            constructor() {
                super();

                extendPropsAndFunctions(this, serverAPI);
            }
        }

        if(Object.getPrototypeOf(Object.getPrototypeOf(serverAPI))?.constructor) {
            throw new Error("ServerAPI should not be a class without beeing a ServerSession");
        }

        // @ts-ignore
        return ServiceWithTypeInfo;
    }
}

async function runRawFetchTests<Api extends object>(serverAPI: Api, rawFetchTests: (baseUrl: string) => void, path = "/api", options?: Partial<ServerSessionOptions>) {
    resetGlobalState();

    const app = express();
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

    // Install session handler: TODO: this should go into the restuncs server
    app.use(session({
        secret: crypto.randomBytes(32).toString("hex"),
        cookie: {sameSite: true},
        saveUninitialized: false,
        unset: "destroy",
        store: undefined, // Default to MemoryStore, but use a better one for production to prevent against DOS/mem leak. See https://www.npmjs.com/package/express-session
    }));


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
class RestfuncsClient_fixed<Service> extends RestfuncsClient<Service> {
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



test('Proper example with express and type support', async () => {
    class GreeterService extends Service {

        async greet(name: string) {
            return `hello ${name} from the server`
        }

        // ... more functions go here
    }


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
            ,path
        );
    }
});

test('Exceptions', async () => {
    class CustomRestError extends RestError {
        myProperty: string;
    }

    await runClientServerTests({
            throwAnError() {
                throw new Error("Expected test error");
            },

            async asyncThrowAnError() {
                throw new Error("Expected test error");
            },

            throwsString() {
                throw "Expected test error";
            },

            async asyncThrowsString() {
                throw "Expected test error";
            },

            async throwSomething(ball: any) {
                throw ball;
            },

            throwCustomRestError() {
                const e = new CustomRestError("test");
                e.myProperty = "test";
                throw e;
            },

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

            // Custom RestError with attached property:
            try {
                await apiProxy.throwCustomRestError();
                fail(new Error(`Should have thrown`))
            }
            catch (x) {
                expect(x.cause.myProperty).toBe("test");
            }

    });
});

test('Safe methods security', async () => {

    let wasCalled = false; // TODO: We could simply check if methods returned successfully as the non-browser client shouldn't restrict reading the result. But now to lazy to change that.

    class BaseService extends Service{
        unsafeFromBase() {
            wasCalled = true;
            return "ok";
        }

        @safe()
        safeFromBase() {
            wasCalled = true;
            return "ok";
        }

        @safe()
        overwriteMe1() {
            wasCalled = true;
            return "ok";
        }

        @safe()
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

        @safe()
        safeTest() {
            wasCalled = true;
            return "ok";
        }

        @safe()
        overwriteMe1() {
            wasCalled = true;
            return "ok";
        }

        // forgot the @safe annotation -> should not execute the call
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

        class BaseService extends Service {
            static options = {checkArguments: false, logErrors: false, exposeErrors: true}

            // Escalate to 'public'
            public methodIsSafe(...args: Parameters<Service["methodIsSafe"]>) {
                return super.methodIsSafe(...args);
            }
        }
        class Service1 extends BaseService {}
        class Service2 extends BaseService {}
        class Service3 extends BaseService {}
        expect(new Service1().methodIsSafe("getIndex")).toBeTruthy()
        expect(new Service2().methodIsSafe("doCall")).toBeFalsy() // Just test some other random method that exists out there
        expect(new Service3().methodIsSafe("getIndex")).toBeTruthy()

        // With overwrite and @safe:
        class ServiceA extends BaseService{
            @safe()
            async getIndex() {
                return "";
            }
        }
        expect(new ServiceA().methodIsSafe("getIndex")).toBeTruthy()

        // With overwrite but no @safe:
        class ServiceB extends BaseService {
            async getIndex() {
                return "";
            }
        }
        expect(new ServiceB().methodIsSafe("getIndex")).toBeFalsy()

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
    const service = new class extends Service{
        static options = {checkArguments: false}

        // Escalate to 'public'
        public parseQuery(...args: Parameters<Service["parseQuery"]>) {
            return super.parseQuery(...args);
        }
    }();
    expect(service.parseQuery("book=1984&&author=George%20Orwell&keyWithoutValue").result).toStrictEqual({ book: "1984", author:"George Orwell", keyWithoutValue:"true" })
    expect(service.parseQuery("1984,George%20Orwell").result).toStrictEqual(["1984", "George Orwell"]);
    expect(service.parseQuery("a%20=1&b%20x=2&c%20").result).toStrictEqual({"a ": "1", "b x": "2", "c ": "true"}); // uricomponent encoded keys
    expect(service.parseQuery("a=1&b=2&c").result).toStrictEqual({a: "1", b: "2", "c": "true"});
    expect(service.parseQuery("&c").result).toStrictEqual({"c": "true"});
    expect(service.parseQuery("George%20Orwell").result).toStrictEqual(["George Orwell"]);

});

test('registerIds', () => {
    // TODO
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


    const server = createServer(MyService);
    try {
        // @ts-ignore
        const port = server.address().port;
        const apiProxy = new RestfuncsClient_fixed<MyService>(`http://localhost:${port}`, {}).proxy

        await apiProxy.checkInitialSessionValues();

        // Set a value
        await apiProxy.storeValueInSession(123);
        expect(await apiProxy.getValueFromSession()).toBe(123);

        // Set a value to null:
        await apiProxy.storeValueInSession(null);
        expect(await apiProxy.getValueFromSession()).toBe(null);

        await apiProxy.setSomeObject_x("test");
        expect(await apiProxy.getSomeObject_x()).toBe("test");

        // Set a value to undefined
        await apiProxy.storeValueInSession(undefined);
        expect(await apiProxy.getValueFromSession()).toBe(undefined);
    }
    finally {
        // shut down server:
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
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

    const server = createServer(MyService);
    try {
        // @ts-ignore
        const port = server.address().port;

        // @ts-ignore
        const client = new RestfuncsClient_fixed<MyService>(`http://localhost:${port}`, {})
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
            expect(shieldTokenAgainstBREACH_unwrap(<string>getCurrentToken())).toStrictEqual(shieldTokenAgainstBREACH_unwrap(validToken) ); // The new token should have been fetched. Assert: getCurrentToken() === valid
        }

    }
    finally {
        // shut down server:
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
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
        const apiProxy = new MyClient(`http://localhost:${port}`).proxy;

        expect(await apiProxy.getSomething("a")).toBe("b");
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

        const apiProxy = new MyRestfuncsClient(`http://localhost:${port}`).proxy;

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
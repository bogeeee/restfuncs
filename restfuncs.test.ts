import {diagnosis_looksLikeJSON, restfuncs, RestService} from "restfuncs-server";
import express from "express";
import {RestfuncsClient, restfuncsClient} from "restfuncs-client";

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible

async function runClientServerTests<Api extends object>(serverAPI: Api, clientTests: (proxy: Api) => void, path = "/api") {
    const app = express();
    app.use(path, restfuncs(serverAPI, {checkArguments: false}));
    const server = app.listen();
    // @ts-ignore
    const serverPort = server.address().port;

    try {
        const client = restfuncsClient<Api>(`http://localhost:${serverPort}${path}`);
        await clientTests(client);
    }
    finally {
        // shut down server
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

async function runRawFetchTests<Api extends object>(serverAPI: Api, rawFetchTests: (baseUrl: string) => void, path = "/api") {
    const app = express();
    app.use(path, restfuncs(serverAPI, {checkArguments: false}));
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

async function expectAsyncFunctionToThrow(f: (...any) => any, expected?: string | RegExp | Error | jest.Constructable) {
    let caught = null;
    try {
        const result = await f();
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

test('Most simple example (standalone http server)', async () => {
    const server = restfuncs({
        greet: (name) =>  `Hello ${name} from the server`
    }, 0, {checkArguments: false});

    try {
        // @ts-ignore
        const port = server.address().port;

        const remote = restfuncsClient(`http://localhost:${port}`)
        // @ts-ignore
        expect(await remote.greet("Bob")).toBe("Hello Bob from the server");
    }
    finally {
        // shut down server
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
})

test('Proper example with express and type support', async () => {
    class GreeterService extends RestService {

        async greet(name: string) {
            return `hello ${name} from the server`
        }

        // ... more functions go here
    }


    const app = express();
    app.use("/greeterAPI", restfuncs( new GreeterService(), {checkArguments: false} ));
    const server = app.listen();

    try {
        // @ts-ignore
        const serverPort = server.address().port;

        const greeterService = restfuncsClient<GreeterService>(`http://localhost:${serverPort}/greeterAPI`)
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

            usualFunc() {

            }

        }
        ,async (apiProxy) => {
            const client = restfuncsClient(`http://localhost:${63000}/apiXY`); // Connect to server port that does not yet exist


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

    });
});

test('GET methods security', async () => {

    let getTestTriggered = false;
    let postTestTriggered = false;

    await runRawFetchTests({
        getTest() {
            getTestTriggered = true;
            return "ok";
        },
        postTest() {
            postTestTriggered = true;
        },
    }, async (baseUrl) => {
        await fetch(`${baseUrl}/getTest`, {method: "GET"});
        expect(getTestTriggered).toBeTruthy();

        await fetch(`${baseUrl}/postTest`, {method: "GET"});
        expect(postTestTriggered).toBeFalsy();
    });
})

test('various call styles', async () => {

    await runRawFetchTests(new class {
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

    }, async (baseUrl) => {

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
        expect(await fetchJson(`${baseUrl}/getBook?a,b`, {method: "GET"})).toStrictEqual(["a", "b"]); // List the arguments (unnamed) in the querystring
        expect(await fetchJson(`${baseUrl}/book/a?authorFilter=b`, {method: "GET"})).toStrictEqual(["a", "b"]);
        expect(await fetchJson(`${baseUrl}/getBook`, {method: "POST"})).toStrictEqual([null, null]); //
        expect(await fetchJson(`${baseUrl}/getBook`, {method: "POST", body: '{"name": "a"}'})).toStrictEqual(["a", null]); //
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

        // With Buffer in parameters:
        expect(await fetchJson(`${baseUrl}/withBuffer?b=b&c=c`, {method: "POST", body: 'a'})).toStrictEqual(["a", "b","c"]);
        expect(await fetchJson(`${baseUrl}/withBuffer2/a?c=c`, {method: "POST", body: 'b'})).toStrictEqual(["a", "b","c"]);
        expect(await fetchJson(`${baseUrl}/withBuffer2/a?b=fromQuery&c=c`, {method: "POST", body: 'b'})).toStrictEqual(["a", "b","c"]); // from query should not overwrite

        // Invalid parameters
        await expectAsyncFunctionToThrow(async () => {await fetchJson(`${baseUrl}/getBook?invalidName=test`, {method: "GET"})}, "does not have a parameter");
        await expectAsyncFunctionToThrow(async () => {await fetchJson(`${baseUrl}/getBook?invalidName=test`, {method: "GET"})}, "does not have a parameter");
        await expectAsyncFunctionToThrow(async () => {await fetchJson(`${baseUrl}/mixed/a?b=b&c=c`, {method: "GET"})},/Cannot set .* through named/);



        // TODO
    });
})

const variousDifferentTypes = ["", null, undefined, true, false, 49, 0, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}, [], [1,2,3], "null", "undefined", "0", "true", "false", "[]", "{}", "''", new Date()];

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

test('.req, .resp and Resources leaks', async () => {
        await new Promise<void>(async (resolve, reject) => {
            try {
                const serverAPI = new class extends RestService {
                    async myMethod() {
                        // test ac
                        expect(this.req.path).toContain("/myMethod");
                        this.resp.setHeader("myHeader", "123"); // test setting headers before the content is sent.
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
    expect(new RestService().parseQuery("book=1984&&author=George%20Orwell&keyWithoutValue").result).toStrictEqual({ book: "1984", author:"George Orwell", keyWithoutValue:"true" })
    expect(new RestService().parseQuery("1984,George%20Orwell").result).toStrictEqual(["1984", "George Orwell"]);
    expect(new RestService().parseQuery("a%20=1&b%20x=2&c%20").result).toStrictEqual({"a ": "1", "b x": "2", "c ": "true"}); // uricomponent encoded keys
    expect(new RestService().parseQuery("a=1&b=2&c").result).toStrictEqual({a: "1", b: "2", "c": "true"});
    expect(new RestService().parseQuery("&c").result).toStrictEqual({"c": "true"});
    expect(new RestService().parseQuery("George%20Orwell").result).toStrictEqual(["George Orwell"]);

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
    await runClientServerTests(new class extends RestService{

    },async apiProxy => {
        for(const forbiddenName of ["req", "resp", "session"]) {
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

test("Access 'this' on server service", async () => {
    await runClientServerTests(new class extends RestService{
        a = "test";
        myServiceFields= {
            val: null
        }

        storeValue(value) {
            this.myServiceFields.val = value;
        }

        getValue() {
            return this.myServiceFields.val;
        }
    },async apiProxy => {
        await apiProxy.storeValue(123);
        expect(await apiProxy.getValue()).toBe(123);
    });
});

test('Sessions', async () => {
    class Service extends RestService{
        session = {
            counter: 0,
            val: null,
            someObject: {x:0}
        }

        checkInitialSessionValues() {
            expect(this.session.counter).toBe(0);
            expect(this.session.val).toBe(null);
            expect(this.session.someObject).toStrictEqual({x:0});
            // @ts-ignore
            expect(this.session.undefinedProp).toBe(undefined);

            // Test the proxy's setter / getter:
            this.session.counter++;
            expect(this.session.counter).toBe(1);
            expect( () => this.session.counter = undefined).toThrow();
            this.session.counter = null;
            expect(this.session.counter).toBe(null);
        }

        storeValueInSession(value) {
            this.session.val = value;
        }

        getValueFromSession() {
            return this.session.val;
        }
    }

    // Use with standalone server cause there should be a session handler installed:
    const server = restfuncs(new Service(),0, {checkArguments: false});
    try {
        // @ts-ignore
        const port = server.address().port;
        const apiProxy = restfuncsClient<Service>(`http://localhost:${port}`)

        await apiProxy.checkInitialSessionValues();

        await apiProxy.storeValueInSession(123);
        expect(await apiProxy.getValueFromSession()).toBe(123); // Test currently fails. We account this to node's unfinished / experimental implementation of the fetch api
    }
    finally {
        // shut down server:
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});


test('Intercept with doCall (client side)', async () => {
    class Service extends RestService{
        getSomething(something: any) {
            return something;
        }
    }

    // Use with standalone server cause there should be a session handler installed:
    const server = restfuncs(new Service(),0, {checkArguments: false});

    // @ts-ignore
    const port = server.address().port;

    try {
        const apiProxy = restfuncsClient<Service>(`http://localhost:${port}`, {
            async doCall(funcName: string, args: any[]) {
                args[0] = "b"
                return await this[funcName](...args) // Call the original function
            }
        });

        expect(await apiProxy.getSomething("a")).toBe("b");
    }
    finally {
        // shut down server:
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('Intercept with doFetch (client side)', async () => {
    class Service extends RestService{
        getSomething(something: any) {
            return something;
        }
    }

    // Use with standalone server cause there should be a session handler installed:
    const server = restfuncs(new Service(),0, {checkArguments: false});

    // @ts-ignore
    const port = server.address().port;

    try {
        class MyRestfuncsClient extends RestfuncsClient<Service> {
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


test('validateAndDoCall security', async () => {
   const service = new class extends RestService {
       x = "string";
       myMethod(a,b) {
           return a + b;
       }
   }

    expect(await service.validateAndDoCall("POST","myMethod", ["a","b"], {req: "test", resp: "test", session: {test: true}}, {})).toBe("ab"); // Normal call

    // Malformed method name:
    await expectAsyncFunctionToThrow(async () => await service.validateAndDoCall("POST","validateAndDoCall", [], {}, {}),"reserved name");
    await expectAsyncFunctionToThrow(async () => await service.validateAndDoCall("POST",null, [], {}, {}),"methodName not set");
    await expectAsyncFunctionToThrow(async () => await service.validateAndDoCall("POST","", [], {}, {}),"methodName not set");
    // @ts-ignore
    await expectAsyncFunctionToThrow(async () => await service.validateAndDoCall("POST",{}, [], {}, {}),"not a string");
    await expectAsyncFunctionToThrow(async () => await service.validateAndDoCall("POST","x", [], {}, {}),"not a function");
    await expectAsyncFunctionToThrow(async () => await service.validateAndDoCall("POST","nonExistant", [], {}, {}),"does not exist");

    // malformed args:
   await expectAsyncFunctionToThrow(async () => await service.validateAndDoCall("POST","myMethod", null, {}, {}),"not an array");
    // @ts-ignore
    await expectAsyncFunctionToThrow(async () => await service.validateAndDoCall("POST","myMethod", "", {}, {}),"not an array");
    // @ts-ignore
    await expectAsyncFunctionToThrow(async () => await service.validateAndDoCall("POST","myMethod", {}, {}, {}),"not an array");
    // Further rtti argschecking is done in runtime-typechecking.test.ts

    // malformed enhancementProps:
    for(const invalidEnhancementProps of [null, undefined, "", { unallowed: true}, { x: "anotherstring"}, { myFunc(){}}]) {
        // @ts-ignore
        await expectAsyncFunctionToThrow(async () => await service.validateAndDoCall("POST","myMethod", ["a","b"], invalidEnhancementProps, {}),);
    }
});

import {restify, RestService} from "@restfuncs/server";
import express from "express";
import {RestClient, restClient} from "@restfuncs/client";

let serverPort = 10000; // this is increased
jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible

async function runClientServerTests<Api extends object>(serverAPI: Api, clientTests: (proxy: Api) => void, path = "/api") {
    const app = express();
    app.use(path, restify(serverAPI));
    serverPort++; // Bugfix: axios client throws a "socket hung up" when reusing the same port
    const server = app.listen(serverPort);
    // @ts-ignore
    const client = restClient<Api>(`http://localhost:${serverPort}${path}`);
    await clientTests(client);
    // shut down server
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
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
            expect(await apiProxy.myVoidMethod()).toBeNull();
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
    restify({
        greet: (name) =>  `Hello ${name} from the server`
    }, 9000) // port

    const remote = restClient("http://localhost:9000")
    // @ts-ignore
    expect(await remote.greet("Bob")).toBe("Hello Bob from the server");
})

test('Proper example with express and type support', async () => {
    class GreeterService extends RestService {

        async greet(name: string) {
            return `hello ${name} from the server`
        }

        // ... more functions go here
    }


    const app = express();
    app.use("/greeterAPI", restify( new GreeterService() ));
    app.listen(9001);

    const greeterService = restClient<GreeterService>("http://localhost:9001/greeterAPI")
    expect(await greeterService.greet("Bob")).toBe("hello Bob from the server");
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
            const client = restClient(`http://localhost:${serverPort + 1}/api`); // Connect to server port that does not yet exist


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

const variousDifferentTypes = ["", null, undefined, true, false, 49, 0, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}, [], [1,2,3], "null", "undefined", "0", "true", "false", "[]", "{}", "''"];

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
                    expect(a).toStrictEqual(param !== undefined?param:null);
                    expect(b).toBeFalsy();
                    expect(c).toStrictEqual(param !== undefined?param:null);
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

test('Reserved names', async () => {
    await runClientServerTests(new class extends RestService{

    },async apiProxy => {
        for(const forbiddenName of ["req", "resp", "session"]) {
            // @ts-ignore
            await expectAsyncFunctionToThrow(async () => {await apiProxy.doCall(forbiddenName)}, "You are trying to call a remote method that is a reserved name");
        }

        // Check that these can't be used if not defined:
        for(const forbiddenName of ["get", "set"]) {
            // @ts-ignore
            await expectAsyncFunctionToThrow(async () => {await apiProxy.doCall(forbiddenName)}, "You are trying to call a remote method that does not exist");
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
    const server = restify(new Service(),0);

    // @ts-ignore
    const port = server.address().port;
    const apiProxy = restClient<Service>(`http://localhost:${port}`)

    await apiProxy.checkInitialSessionValues();

    await apiProxy.storeValueInSession(123);
    expect(await apiProxy.getValueFromSession()).toBe(123); // Test currently fails. We account this to node's unfinished / experimental implementation of the fetch api

    // shut down server:
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));

});

test('Intercept calls', async () => {
    class Service extends RestService{
        getSomething(something: any) {
            return something;
        }
    }

    // Use with standalone server cause there should be a session handler installed:
    const server = restify(new Service(),0);

    // @ts-ignore
    const port = server.address().port;

    class MyRestClient extends RestClient {
        async doHttpCall(funcName: string, args: any[], url: string, req: RequestInit) {
            args[0] = "b"; // Mangle
            const r: {result: any, resp: Response} = await super.doHttpCall(funcName, args, url, req);
            return r
        }
    }

    const apiProxy = <Service> <any> new MyRestClient(`http://localhost:${port}`);

    expect(await apiProxy.getSomething("a")).toBe("b");

    // shut down server:
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));

});
import { tags } from "typia";
import 'reflect-metadata'
import {ClientCallback, ServerSession as ServerSession, withTrim} from "restfuncs-server/ServerSession";
import express from "express";
import {reflect} from "typescript-rtti";
import {extendPropsAndFunctions, isTypeInfoAvailable} from "restfuncs-server/Util";
import {ClientProxy, RestfuncsClient} from "restfuncs-client";
import {develop_resetGlobals} from "restfuncs-server/Server";
import {remote, restfuncsExpress, ServerSessionOptions} from "restfuncs-server";
import {ServerPrivateBox, WelcomeInfo} from "restfuncs-common";
import {runClientServerTests, standardOptions} from "./lib";
import _ from "underscore";
import {Readable as Readable_fromNodePackage} from "node:stream";
import {Readable as Readable_fromReadableStreamPackage} from "readable-stream";

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible

const INVALID_ARGUMENTS_MESSAGE = /Invalid argument/;
const INVALID_RETURN_MESSAGE = /returned an invalid value/;


beforeEach(() => {
    develop_resetGlobals();
});

class TypecheckingService extends ServerSession {
    static options: ServerSessionOptions = {...standardOptions, devDisableSecurity: false, logErrors: false, exposeErrors: true }
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

test('Test if if rtti is available', async () => {
    class User {
        id : number;
        username? : string;
        protected favoriteColor? : number | string;
        doIt() { return 123; }
    }

    const reflectedClass = reflect(User);

    expect(reflectedClass.getProperty("xxx")).toBeUndefined(); // seeing this error means, we get a value for ANY nonexisting property. The compilation process does not work properly

    expect(reflectedClass
        .getProperty('favoriteColor')
        .type.is('union')).toBe(true);

    expect(isTypeInfoAvailable(new class {
    })).toBeTruthy();
});

test('Test arguments', async () => {
    class ServerAPI extends TypecheckingService{
        @remote()
        myVoidMethod() {
        }

        @remote()
        params1(x: string) {
        }

        @remote()
        params2(x: string, y: number, z: {}) {
        }

        @remote()
        setObjWithValues(z: {prop1: boolean}) {
        }

        @remote()
        withOptionalArgument(my?: string) {

        }

        @remote()
        withUndefined(my: string | undefined) {

        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            await apiProxy.myVoidMethod();
            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.myVoidMethod("illegalParam"), /Too many arguments|invalid number of arguments/);

            await apiProxy.params1("ok");

            // Too many arguments:
            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.params1("ok", "illegal"), /Too many arguments|invalid number of arguments/);

            // To few arguments:
            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.params1(), INVALID_ARGUMENTS_MESSAGE);

            // With objects:
            await apiProxy.params2("ok", 123, {});

            await apiProxy.setObjWithValues({prop1: true});

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.setObjWithValues({prop1: 123}), /expected.*boolean/i );

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.setObjWithValues({}), INVALID_ARGUMENTS_MESSAGE );

            await apiProxy.withOptionalArgument()
        }
    );
})


describe('Typia tags', () => {
    class ServerAPI extends TypecheckingService{
        @remote()
        methodWithEmail(value: string & tags.Format<"email">) {
        }
    };

    test("email", async () => {
        await runClientServerTests(new ServerAPI(),
            async (apiProxy) => {
                await apiProxy.methodWithEmail("bla@blubb.xy");
                await expectAsyncFunctionToThrow(async () => await apiProxy.methodWithEmail("12334"));
            });
    });
})


test('Test arguments with deep undefined', async () => {
    class ServerAPI extends TypecheckingService{
        @remote()
        withDeepUndefined(my: {deep: string | undefined}) {

        }

        @remote()
        withDeepOptional(my: {deep?: string}) {

        }


    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            await apiProxy.withDeepUndefined({deep: undefined})
            await apiProxy.withDeepOptional({})
        }
    );
})

describe('User defined classes', () => {
    class User {
        name: string
        someMethod() {
            return "original"
        }
    }

    interface IUser {
        name: string
        someMethod(): string;
    }

    class ServerAPI extends TypecheckingService{
        @remote()
        getObject(value: User): any {
            return value
        }

        @remote()
        user_typeOfSomeMethod(user: User): any {
            return typeof user.someMethod;
        }

        @remote()
        iuser_typeOfSomeMethod(user: IUser): any {
            return typeof user.someMethod;
        }


        @remote()
        returnUser(): any {
            const user = new User();
            user.name="someone"
            return user
        }

        @remote()
        withCallbackAndUser(cb: () => void, user: User) {

        }

        @remote()
        withObjectWithMethod(obj: {name: string, someMethod: () => void}) {

        }
    }

    test("basic", async () => {
        await runClientServerTests(new ServerAPI(),
            async (apiProxy) => {
                expect(await apiProxy.getObject({name: "bob"} as User)).toStrictEqual({name: "bob"}) // Expect it to work like this. But still questionable if it should be allowed in general
                expect(await apiProxy.returnUser()).toStrictEqual({name: "someone"});
            }
        , {useSocket: true});
    });

    for(const typ of ["User", "IUser"]) {

        it(`should not be allowed to replace a class method with something else: ${typ}`, async () => {
            await runClientServerTests(new ServerAPI(),
                async (apiProxy) => {
                    const variousValues = ["", true, false, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}, [], [1,2,3]]
                    for(const v of variousValues) {
                        const user = {
                            name: "dummy",
                            someMethod: v
                        }
                        //@ts-ignore
                        expect(typ == "User"?await apiProxy.user_typeOfSomeMethod(user):await apiProxy.iuser_typeOfSomeMethod(user)).toStrictEqual("undefined");
                    }
                }
            );
        });

        it(`should not be allowed to replace a class method with a callback: ${typ}`, async () => {
            await runClientServerTests(new ServerAPI(),
                async (apiProxy) => {
                    const user = {
                        name: "dummy",
                        someMethod: () => {}
                    }

                    // Expect it to arrive but to be undefined (currently not working):
                    //@ts-ignore
                    //expect(typ == "User"?await apiProxy.user_typeOfSomeMethod(user):await apiProxy.iuser_typeOfSomeMethod(user)).toStrictEqual("undefined");

                    // Expect it to throw an error:
                    //@ts-ignore
                    await expectAsyncFunctionToThrow(async () => (typ == "User"?await apiProxy.user_typeOfSomeMethod(user):await apiProxy.iuser_typeOfSomeMethod(user)), /not declared 'inline'/)
                }
            ,{useSocket: true});
        });
    }

    it("should not delete/replace methods on the client side when serializing them", async () => {

        await runClientServerTests(new ServerAPI(), async (apiProxy) => {
                // With a class instance:
                {
                    const user = new User();
                    user.name = "dummy";
                    await apiProxy.withCallbackAndUser(() => {
                    }, user);
                    expect(typeof user.someMethod).toStrictEqual("function");
                }

                // With an object with methods:
                {
                    const objectWithMethod:User  = {name: "dummy", someMethod() {return "x"}};

                    await apiProxy.withObjectWithMethod(objectWithMethod);
                    expect(typeof objectWithMethod.someMethod).toStrictEqual("function");
                }
            }
            , {useSocket: true});

    });
})

test('Test arguments - extra properties value / trim arguments', async () => {

    type IUser=  {
        name: string,
        age: number,
        password: string,
    }

    class ServerAPI extends ServerSession{
        @remote()
        params1(x: string, y: number, z: {}): any {
            return z;
        }

        @remote({trimArguments: false})
        params2(x: string, y: number, z: {}) {
        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            expect( (await apiProxy.params1("ok", 123, {someExtraProperty: true})).someExtraProperty).toBeUndefined();
            await expectAsyncFunctionToThrow( async () => {await apiProxy.params2("ok", 123, {someExtraProperty: true});}, INVALID_ARGUMENTS_MESSAGE);
        }
    );
})

test('trim result', async () => {

    type IUser=  {
        name: string,
        age: number,
        password: string,
        sub?: {
            subExtra: string
        }
    }

    class ServerAPI extends ServerSession {

        @remote({trimResult: false})
        doesntTrimResult(): {} {
            return {extra: true}
        }

        @remote()
        trimResult(): {} {
            return {extra: true}
        }

        @remote()
        async trimResultAsync(): Promise<{}> {
            return {extra: true}
        }

        @remote()
        trimResultImplicit() {
            return {extra: true} as {}
        }

        @remote()
        trimResultWithPick(): Pick<IUser, "name" | "age"> { // This will return the user without password
            const user = {name: "Franz", age: 45, password: "geheim!"}
            return user;
        }

        @remote()
        trimResultWithOmit(): Omit<IUser, "password">{  // This will return the user without password
            const user = {name: "Franz", age: 45, password: "geheim!"}
            return user;
        }

        @remote()
        trimResultWithOmitWithSub(): Omit<IUser, "password" | "sub"> & {sub: Omit<IUser["sub"], "extra">} {
            const user = {name: "Franz", age: 45, password: "geheim!", sub: {subExtra: "extra"}}
            return user;
        }

        @remote({trimResult: false})
        returnAny(): any {
            return {extra: true}
        }

        @remote({trimResult: false})
        returnUnknown(): unknown {
            return {extra: true}
        }


    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            expectAsyncFunctionToThrow(apiProxy.doesntTrimResult, /invalid.*extra/);
            expect(await apiProxy.trimResult()).toStrictEqual({});
            expect(await apiProxy.trimResultAsync()).toStrictEqual({});
            expect(await apiProxy.trimResultImplicit()).toStrictEqual({});
            expect(await apiProxy.trimResultWithPick()).toStrictEqual({name: "Franz", age: 45});
            expect(await apiProxy.trimResultWithOmit()).toStrictEqual({name: "Franz", age: 45});
            expect(await apiProxy.trimResultWithOmitWithSub()).toStrictEqual({name: "Franz", age: 45, sub: {}});

            expect(await apiProxy.returnAny()).toStrictEqual({extra: true});
            expect(await apiProxy.returnUnknown()).toStrictEqual({extra: true});

        }
    );
})

it('should trim result but not modify the original objects', async () => {


    const myObj: {a: boolean} = {
        a:true, extra: "something",
        //extraMethod() {} // this does not work in the first place: "Cannot serialize `value['a']['extra']['extraMethod']` because it is a function"
    } as any
    class ServerAPI extends ServerSession {
        @remote()
        getMyObjTrimmed() {
            return myObj
        }

        @remote({trimResult: false, validateResult: false})
        getOriginalMyObj() {
            return myObj
        }
    }

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            expect(await apiProxy.getOriginalMyObj()).toStrictEqual({a:true, extra: "something"})
            expect(await apiProxy.getMyObjTrimmed()).toStrictEqual({a:true})
            expect(await apiProxy.getOriginalMyObj()).toStrictEqual({a:true, extra: "something"}) // Should still have the extra property
        }
    );
})


it('should trim result but not modify prototype fields', async () => {

    const protoObject = {
        extra: "something",
        extraMethod() {
        }
    }

    const myObj={a: true};
    Object.setPrototypeOf(myObj, protoObject);

    class ServerAPI extends ServerSession {
        @remote()
        getMyObjTrimmed() {
            return myObj
        }

        @remote({trimResult: false, validateResult: false})
        getOriginalMyObj() {
            return myObj
        }
    }

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            const result = await apiProxy.getOriginalMyObj();
            //expect((result as any).extra).toStrictEqual("something") // Should still have the extra property ideally. But this does not work: No known json serializer seems to include the prototype properties, nor does jest's expect(someObj).toStrictEqual. And it's not common to use such / rather a bad practice.

            expect(await apiProxy.getMyObjTrimmed()).toStrictEqual({a:true})
            expect((myObj as any).extra).toStrictEqual("something") // Should still have the extra property
            expect((myObj as any).extraMethod).toBeDefined() // Should still have the extra method

        }
    );
})

test('Test BigInt', async () => {

    class A {
        i: BigInt
    }

    const iProp = reflect(A).getProperty("i");
    expect(iProp.matchesValue(123n)).toBe(true);
    expect(iProp.matchesValue(undefined)).toBe(false);
    expect(iProp.matchesValue(null)).toBe(false);
    expect(iProp.matchesValue(123)).toBe(false);
    expect(iProp.matchesValue("")).toBe(false);
    expect(iProp.matchesValue(-1)).toBe(false);
    expect(iProp.matchesValue(Number.NaN)).toBe(false);
    expect(iProp.matchesValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(iProp.matchesValue(Number.NEGATIVE_INFINITY)).toBe(false);
})

/**
 * See https://github.com/typescript-rtti/typescript-rtti/issues/92
 */
test('Test additional properties / overstrict checks', async () => {
    class ServerAPI extends TypecheckingService {
        @remote({trimArguments: false})
        setObjWithValues(z: {prop1: boolean}) {
        }

    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.setObjWithValues({prop1: true, poisonedProp: true}), INVALID_ARGUMENTS_MESSAGE );
        }
    );
})


test('Test rest arguments', async () => {
    class ServerAPI extends TypecheckingService {
        @remote()
        restParams(x: string, ...y: number[]) {

        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            await apiProxy.restParams("x");
            await apiProxy.restParams("x", 1,2,3);

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", 1,2,3, {}), INVALID_ARGUMENTS_MESSAGE );

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", 1,2,3, undefined), INVALID_ARGUMENTS_MESSAGE );

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", 1,undefined,3), INVALID_ARGUMENTS_MESSAGE );

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", []), INVALID_ARGUMENTS_MESSAGE );

            const variousInvalidRestParams = ["", null, undefined, true, false, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}, [], [1,2,3], "null", "undefined", "0", "true", "false", "[]", "{}", "''"]
            for(let p of variousInvalidRestParams) {
                // @ts-ignore
                await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", p), INVALID_ARGUMENTS_MESSAGE );
            }

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", []), INVALID_ARGUMENTS_MESSAGE );

        }
    );
})

/**
 * See https://github.com/typescript-rtti/typescript-rtti/issues/92
 */
test('Test result validation', async () => {
    class ServerAPI extends TypecheckingService {

        @remote()
        returnsString(value: any): string {
            return value
        }

        @remote()
        async returnsStringViaPromise(value: any): Promise<string> {
            return value
        }

        @remote()
        returnsStringImplicitly(value: any) {
            let myString: string;
            myString = value;
            return myString
        }

        @remote()
        async returnsStringImplicitlyViaPromise(value: any) {
            let myString: string;
            myString = value;
            return myString
        }

        @remote()
        voidMethodReturnsIllegalValue(): void {
            // @ts-ignore
            return "test";
        }

        @remote({validateResult: false})
        returnsIllegalValuesVithoutValidation():string {
            // @ts-ignore
            return {}
        }

        @remote()
        returnsOptionalString(value: any): string | undefined {
            return value;
        }

        @remote()
        returnsImplicitOptionalString(value: string | undefined) {
            return value;
        }

        @remote()
        returnsObject(value: any): {z: string} {
            return value
        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            const variousValues = ["", true, false, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}, [], [1,2,3], "null", "undefined", "0", "true", "false", "[]", "{}", "''"]
            for(const value of variousValues) {
                if(typeof value === "string") {
                    await apiProxy.returnsString(value)
                    await apiProxy.returnsStringViaPromise(value)
                    await apiProxy.returnsStringImplicitly(value)
                    await apiProxy.returnsStringImplicitlyViaPromise(value)
                }
                else {
                    await expectAsyncFunctionToThrow(async () => await apiProxy.returnsString(value), INVALID_RETURN_MESSAGE);
                    await expectAsyncFunctionToThrow(async () => await apiProxy.returnsStringViaPromise(value), INVALID_RETURN_MESSAGE);
                    await expectAsyncFunctionToThrow(async () => await apiProxy.returnsStringImplicitly(value), INVALID_RETURN_MESSAGE);
                    await expectAsyncFunctionToThrow(async () => await apiProxy.returnsStringImplicitlyViaPromise(value), INVALID_RETURN_MESSAGE);
                }
            }

            expect(await apiProxy.returnsOptionalString(undefined)).toBe(undefined);

            await expectAsyncFunctionToThrow(async () => await apiProxy.voidMethodReturnsIllegalValue(), INVALID_RETURN_MESSAGE);
            await apiProxy.returnsIllegalValuesVithoutValidation();

            await expectAsyncFunctionToThrow(async () => await apiProxy.returnsObject({z: 123}), /invalid.*\.z/); // .z should be contained in the message
            await expectAsyncFunctionToThrow(async () => await apiProxy.returnsString(123), /invalid.*123/); // .z should be contained in the message
        }
    );
})

test('Test result validation with null and undefined', async () => {
    class ServerAPI extends TypecheckingService {
        @remote()
        returnsString(value: any): string {
            return value
        }

        @remote()
        async returnsStringViaPromise(value: any): Promise<string> {
            return value
        }

        @remote()
        returnsStringImplicitly(value: any) {
            let myString: string;
            myString = value;
            return myString
        }

        @remote()
        async returnsStringImplicitlyViaPromise(value: any) {
            let myString: string;
            myString = value;
            return myString
        }

        @remote()
        voidMethodReturnsIllegalValue(): void {
            // @ts-ignore
            return "test";
        }

        @remote({validateResult: false})
        returnsIllegalValuesVithoutValidation():string {
            // @ts-ignore
            return {}
        }

        @remote()
        returnsOptionalString(value: any): string | undefined {
            return value;
        }

        @remote()
        returnsImplicitOptionalString(value: string | undefined) {
            return value;
        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            const variousValues = [null, undefined]
            for(const value of variousValues) {
                await expectAsyncFunctionToThrow(async () => await apiProxy.returnsString(value), INVALID_RETURN_MESSAGE);
                await expectAsyncFunctionToThrow(async () => await apiProxy.returnsStringViaPromise(value), INVALID_RETURN_MESSAGE);
                await expectAsyncFunctionToThrow(async () => await apiProxy.returnsStringImplicitly(value), INVALID_RETURN_MESSAGE);
                await expectAsyncFunctionToThrow(async () => await apiProxy.returnsStringImplicitlyViaPromise(value), INVALID_RETURN_MESSAGE);
            }

            expect(await apiProxy.returnsOptionalString(undefined)).toBe(undefined);

            await expectAsyncFunctionToThrow(async () => await apiProxy.voidMethodReturnsIllegalValue(), INVALID_RETURN_MESSAGE);
            await apiProxy.returnsIllegalValuesVithoutValidation();

        }
    );
})

describe("callbacks", () => {
    class User {
        name: string
        someMethod() {
            return "fromServer"
        }
    }

    class ServerAPI extends TypecheckingService {
        @remote()
        async withSimpleCallbackParam(cb: (...args: any) => void) {

        }

        @remote()
        async callVoidPromiseCallback(callback: ()=> Promise<void>) {
            await callback();
        }

        @remote()
        async callStringPromiseCallback(callback: ()=> Promise<string>) {
            return await callback();
        }

        @remote()
        async putArgsIntoCallback(callback: (a: string, b: number, c?: {myFlag: boolean})=> Promise<any>, args:any[]) {
            return await callback.call(undefined,...args);
        }

        @remote()
        async putArgsIntoCallbackWithTrim(callback: (a: string, b: number, c?: {myFlag: boolean})=> Promise<any>, args:any[], trimArgs: boolean, trimResult: boolean) {
            return await withTrim(callback, trimArgs, trimResult).call(undefined,...args);
        }

        @remote()
        async callWithTrim(callback: (a: string, b: number, c?: {myFlag: boolean})=> Promise<any>, args:any[]) {
            return await withTrim(callback).call(undefined,...args);
        }
        @remote()

        async callObjectPromiseCallback(callback: ()=> Promise<{a: string, b?:number }>) {
            return await callback();
        }

        @remote()
        async callObjectPromiseCallbackWithTrim(callback: ()=> Promise<{a: string, b?:number }>, trimArgs: boolean, trimResult: boolean) {
            return await withTrim(callback, trimArgs, trimResult)();
        }

        @remote()
        async alsoWithStringParam(callback1: ()=> void, someString: string) {
        }

        @remote()
        async twoCallbacks(callback1: ()=> void, callback2: ()=> void) {
            callback1();
            callback2();
        }

        @remote()
        async callbacksInDeepParam(p: {x: {cbs: ((p: string) => void)[]}}, argForCallbacks: any) {
            if(p.x.cbs.length === 0) {
                throw new Error("No callbacks seen");
            }

            p.x.cbs.forEach(cb => cb(argForCallbacks as string)); // call them
        }

        @remote()
        async wthStringSomewhere(p:{x: string}) {
            return p.x;
        }

        @remote()
        async withUser(user: User) {
            if(user.someMethod === undefined) {
                return "OK";
            }

            if(user.someMethod() !== "fromServer") {
                throw new Error("Unexpected result");
            }
        }

        @remote()
        withTrimLeavesOriginalObjectIntact(cb: (obj: {x: string}) => void) {
            const objWithExtraProps = {x: "123", extraProp: "extra"}
            withTrim(cb)(objWithExtraProps);
            return objWithExtraProps.extraProp === "extra"; // is still intact ?
        }
    }

    it("should allow legal args in a simple callback", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        const mock = jest.fn();

        await apiProxy.putArgsIntoCallback(mock, ["abc", 3, {myFlag: true}])

    }, {
        useSocket: true
    }));

    it("should error when putting illegal args into a simple callback", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        const mock = jest.fn();

        await expectAsyncFunctionToThrow(async () => apiProxy.putArgsIntoCallback(mock, []), /invalid number of arguments/i)
        await expectAsyncFunctionToThrow(async () => apiProxy.putArgsIntoCallback(mock, [1,2,3,4]), /invalid number of arguments/i)
        await expectAsyncFunctionToThrow(async () => apiProxy.putArgsIntoCallback(mock, [123,3]), /expected.*string.*123/)
        await expectAsyncFunctionToThrow(async () => apiProxy.putArgsIntoCallback(mock, ["abc","x"]), /expected.*number.*x/)

    }, {
        useSocket: true
    }));

    it("should trim extra properties", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        async function returnExact(...args:any[]) { return args}

        expect(await apiProxy.putArgsIntoCallbackWithTrim(returnExact, ["abc", 3, {myFlag: true, extraProperty: true}], true, false)).toStrictEqual(["abc", 3, {myFlag: true}])

    }, {
        useSocket: true
    }));

    it("should fail with extra properties when trimArguments is disabled", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        async function returnExact(...args:any[]) { return args}

        await expectAsyncFunctionToThrow(() => apiProxy.putArgsIntoCallback        (returnExact, ["abc", 3, {myFlag: true, extraProperty: true}]), /extraProperty/);
        await expectAsyncFunctionToThrow(() => apiProxy.putArgsIntoCallbackWithTrim(returnExact, ["abc", 3, {myFlag: true, extraProperty: true}],false /* !!!! */, true), /extraProperty/); // Minor: Lets just test the other way

    }, {
        useSocket: true
    }));




    it("should error when a callback with Promise<void> returns non-void", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        const mock = jest.fn();
        await apiProxy.callVoidPromiseCallback(async () => {});
        // @ts-ignore
        await expectAsyncFunctionToThrow(async () => apiProxy.callVoidPromiseCallback(async () => {return "aString"}), /aString/)

    }, {
        useSocket: true
    }));

    it("should error when a callback with Promise<string> returns number", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        const mock = jest.fn();
        await apiProxy.callVoidPromiseCallback(async () => {});
        // @ts-ignore
        await expectAsyncFunctionToThrow(async () => apiProxy.callStringPromiseCallback(async () => {return 123}), /expected.*string.*123/i)

    }, {
        useSocket: true
    }));

    it("should trim extra properties off the result", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        expect(await apiProxy.callObjectPromiseCallbackWithTrim(async () => {return {a: "123", b: 4, extraProp: true} as any}, false,true )).toStrictEqual({a: "123", b: 4})
    }, {
        useSocket: true
    }));

    test("Result: should fail with extra properties when trimArguments is disabled", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        await expectAsyncFunctionToThrow(() => apiProxy.callObjectPromiseCallback(async () => {
            return {a: "123", b: 4, extraProp: true} as any
        }), /extraProp/);

    }, {
        useSocket: true
    }));

    it("should fail when trying to inject a callback into a string param", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        //@ts-ignore
        await expectAsyncFunctionToThrow(() => apiProxy.alsoWithStringParam(async () => {} ,() => {}) );
    }, {
        useSocket: true
    }));

    it("should fail when trying to inject a placeholder string into a callback param", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        //@ts-ignore
        await expectAsyncFunctionToThrow(() => apiProxy.withSimpleCallbackParam("_callback") );
        //@ts-ignore
        await expectAsyncFunctionToThrow(() => apiProxy.withSimpleCallbackParam("_callback0") );
    }, {
        useSocket: true
    }));

    it("should fail when trying to inject something else into a callback param", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        const variousValues = ["", true, false, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}, [], [1,2,3]]
        for(const v of variousValues) {
            //@ts-ignore
            await expectAsyncFunctionToThrow(() => apiProxy.withSimpleCallbackParam(v) );
        }

    }, {
        useSocket: true
    }));

    it("should not be forbidden to use placeholder strings", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        expect(await apiProxy.wthStringSomewhere({x: "_callback"})).toStrictEqual("_callback");
        expect(await apiProxy.wthStringSomewhere({x: "_callback0"})).toStrictEqual("_callback0");
        expect(await apiProxy.wthStringSomewhere({x: "_callbackAbc123"})).toStrictEqual("_callbackAbc123");
    }, {
        useSocket: true
    }));

    test("Two callback signatures should currently not be possible", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        await expectAsyncFunctionToThrow(() => apiProxy.twoCallbacks(() => {}, () => {}) );
    }, {
        useSocket: true
    }));

    test("Callbacks deep in params", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        await apiProxy.callbacksInDeepParam({x: {cbs: [(a:string) => {}, (a:string) => {}]}}, "");

        await expectAsyncFunctionToThrow(() => apiProxy.callbacksInDeepParam({x: {cbs: [(a:string) => {}, (a:string) => {}]}}, 123));
    }, {
        useSocket: true
    }));

    test("Client's class instances with functions should not be allowed", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        class ClientUser extends User {
            name = "dummy"
            someMethod():string {
                throw new Error("this should not be called");
            }
        }
        const user = new ClientUser()
        expect(await apiProxy.withUser(user)).toStrictEqual("OK");  // Currently, the class methods are not transferred.
        //await expectAsyncFunctionToThrow(() => apiProxy.withUser(user), /.*allowCallbacksAnywhere.*/); // Otherwise, there should be the hint for that option
    }, {
        useSocket: true
    }));

    test("withTrim should not modify the original object", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        expect(await apiProxy.withTrimLeavesOriginalObjectIntact((dumny: any) => {})).toBeTruthy();
    }, {
        useSocket: true
    }));
});

describe("callbacks with mixed security requirements", () => {

    class SecDisabledAPI extends ServerSession {
        static options: ServerSessionOptions = {
            devDisableSecurity: true,
            logErrors: false,
            exposeErrors: true
        }

        @remote()
        async putInvalidValueIntoCallback(cb: (a: string) => Promise<string>) {
            //@ts-ignore
            await cb(123);
        }
    }

    class ServerAPI extends TypecheckingService {
        @remote({validateCallbackArguments: false})
        async nonValidate_putInvalidValueIntoCallback(cb: (a: string) => Promise<string>) {
            //@ts-ignore
            await cb(123);
        }

        @remote({validateCallbackResult: false})
        async nonValidateResult_putValueIntoCallback(cb: (a: string) => Promise<string>, value?: string) {
            await cb(value || "dummy");
        }

        @remote()
        async putValueIntoCallback(cb: (a: string) => Promise<string>, value: string) {
            return await cb(value);
        }

        @remote()
        args_placeAWithValidationEnabled(cb: (a:string) => void) {

        }

        @remote({validateCallbackArguments: false})
        args_placeBWithValidationDisabled(cb: (a:string) => void, valueForCall: any) {
            cb(valueForCall);
        }

        @remote()
        result_placeAWithValidationEnabled(cb: () => Promise<string>) {

        }

        @remote({validateCallbackResult: false})
        async result_placeBWithValidationDisabled(cb: () => Promise<string>) {
            await cb();
        }


        @remote()
        differentSignatures_args_A(cb: (a:string) => void) {
            cb("");
        }

        @remote()
        differentSignatures_args_B(cb: (a:number) => void) {
            cb(123);
        }


        @remote()
        async differentSignatures_result_A(cb: () => Promise<string>) {
            await cb();
        }

        @remote()
        async differentSignatures_result_B(cb: () => Promise<number>) {
            await cb();
        }
    }

    it("should not validate arguments or params witch devDisableSecurity", () => runClientServerTests(new SecDisabledAPI, async (apiProxy) => {
        await apiProxy.putInvalidValueIntoCallback(async (dummy) => ""); // Should work
        //@ts-ignore
        await apiProxy.putInvalidValueIntoCallback(async (dummy) => 123); // Returning a an invalid number should be ok
    }, { useSocket: true }));

    it("should not validate arguments when set in the remoteMethodOptions", () => runClientServerTests(new ServerAPI(), async (apiProxy) => {
        await apiProxy.nonValidate_putInvalidValueIntoCallback((async (dummy) => "")); // Should work
    }, { useSocket: true}));

    it("should not validate result when set disabled the remoteMethodOptions", () => runClientServerTests(new ServerAPI(), async (apiProxy) => {
        //@ts-ignore
        await apiProxy.nonValidateResult_putValueIntoCallback((async (dummy) => 123)); // Returning a an invalid number should be ok
        //@ts-ignore
        await expectAsyncFunctionToThrow(() => apiProxy.nonValidateResult_putValueIntoCallback((async (dummy) => 123), 123)); // Minor importance: Lett's mix it: allow invalid result, but the arguments should still be validated
    }, {useSocket: true}));

    it("Args: should fail validation in mixed case", () => runClientServerTests(new ServerAPI(), async (apiProxy) => {
        function myCallback(a: string) {}
        await apiProxy.args_placeBWithValidationDisabled(myCallback, 123); // Should work with anvalid param for now
        await apiProxy.args_placeAWithValidationEnabled(myCallback);
        await expectAsyncFunctionToThrow(() =>  apiProxy.args_placeBWithValidationDisabled(myCallback, 123)); // Should not work anymore, after myCallback was not used in another place

    }, {useSocket: true}));

    it("Result: should fail validation in mixed case", () => runClientServerTests(new ServerAPI(), async (apiProxy) => {
        async function myFaultyCallback(): Promise<string> {
            //@ts-ignore
            return 123;
        }
        await apiProxy.result_placeBWithValidationDisabled(myFaultyCallback); // Should work with anvalid param for now
        await apiProxy.result_placeAWithValidationEnabled(myFaultyCallback);
        await expectAsyncFunctionToThrow(() =>  apiProxy.args_placeBWithValidationDisabled(myFaultyCallback, 123)); // Should not work anymore, after myFaultyCallback was not used in another place

    }, {useSocket: true}));

    it("should fail with different arg signatures", () => runClientServerTests(new ServerAPI(), async (apiProxy) => {
        function myReusableCallback(arg: any) {}

        await apiProxy.differentSignatures_args_A(myReusableCallback) // should work
        await expectAsyncFunctionToThrow(() => apiProxy.differentSignatures_args_B(myReusableCallback), /.*string.*(number|123)/s); // Expect the error message to properly explain it

    }, {useSocket: true}));

    it("should fail with different result signatures", () => runClientServerTests(new ServerAPI(), async (apiProxy) => {
        async function myReusableCallback(): Promise<any> {
            return ""
        }

        await apiProxy.differentSignatures_result_A(myReusableCallback) // should work
        await expectAsyncFunctionToThrow(() => apiProxy.differentSignatures_result_B(myReusableCallback), /.*Promise<string>.*Promise<number>/s); // Expect the error message to properly explain it

    }, {useSocket: true}));
})

describe("Streams", () => {
    class MyServerSession extends TypecheckingService {
        @remote methodThatReturnsStreamDeeply() {
            return {readable: new Readable_fromNodePackage()}
        }
    }

    it("should tell you to disable result validation when streams area returned deeply", () => runClientServerTests(new MyServerSession(), async (apiProxy) => {
        await expectAsyncFunctionToThrow(async () => await apiProxy.methodThatReturnsStreamDeeply(), "disable result validation"); // Should be handled somewhere in replaceDTOs

        }, {useSocket: true}
    ));
});

/*
// Not yet implemented
test('Test destructuring arguments', async () => {
    class ServerAPI {
        restParams(x: string, {a: boolean, b: string}) {

        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            await apiProxy.restParams("x", {a: true, b: "test"});

            const variousInvalidParams = ["", null, undefined, true, false, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}, [], [1,2,3], "null", "undefined", "0", "true", "false", "[]", "{}", "''"]
            for(let p of variousInvalidParams) {
                // @ts-ignore
                await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", p) );
            }

        }
    );

});
*/

/*
// Anonymous classes can't have @remote decorators, so its meaningless to test them
test('Test with anonymous class', async () => {

    await runClientServerTests(new class extends TypecheckingService{
            params1(x: string) {
            }
        },
        async (apiProxy) => {
            await apiProxy.params1("ok");

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.params1("ok", "illegal"), "Too many arguments");
        }
    );
})
*/

/*
// This one fails with current typescript-rtti. But that's not a showstopper.
test('Test anonymous object as service', async () => {
    await runClientServerTests({
            myVoidMethod() {
            },
            params1(x: string) {
            },
            params2(x: string, y: number, z: {}) {
            },
        },
        async (apiProxy) => {
            await apiProxy.params1("ok");

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.params1("ok", "illegal"), "Too many arguments");
        }
    );
})
*/
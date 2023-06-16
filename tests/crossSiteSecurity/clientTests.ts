import {RestfuncsClient, restfuncsClient} from "restfuncs-client"
import {TestsService} from "./TestsService";
import {MainframeService} from "./MainframeService";
import {ControlService} from "./ControlService";

export const mainSiteUrl = "http://localhost:3000";
export const isMainSite = window.location.href.startsWith(mainSiteUrl);
let failed = false;
const debug_failAllTestsOnFirstFail = false; // enable to have a better error stack trace in the console (use firefox instead of chrome then)

async function assertRuns(fn: () => Promise<void>) {
    await fn();
}

async function assertFails(fn: () => Promise<void>) {
    try {
        await fn();
        throw new Error("Expected to fail");
    }
    catch (e) {
        // ok
    }
}


function failTests(e: unknown) {
    failed = true;
    if(e) {
        if (debug_failAllTestsOnFirstFail) {
            throw e;
        }
        console.error(e);
    }
}

/**
 * Assert that it should fail same-site and also cross site
 *
 * function will report one failed test instead of throwing an Error
 * @param description
 * @param fn
 */
async function testAssertFailsSSAndXS(description: string, fn:() => Promise<void>) {
    console.log(description + "...");
    try {
        await assertFails(fn);
        console.log(`...expectedly fails`)
    }
    catch (e) {
        console.log(`...!!! runs but was expected to fail`)
        failTests(null);
    }

}

/**
 * Assert that it should work same-site and also cross site
 * function will report one failed test instead of throwing an Error
 * @param description
 * @param fn
 */
async function testAssertWorksSSAndXS(description: string, fn: () => Promise<void>) {
    console.log(description + "...");
    try {
        await assertRuns(fn);
        console.log(`...expectedly runs ${isMainSite?"": "cross site "}`)
    }
    catch (e) {
        console.log(`...!!! unexpectedly failed ${isMainSite?"": "cross site"}. See the following error:`)
        failTests(e)
    }

}

/**
 * Assert that it should work same-site but fail cross-site
 *
 * function will report one failed test instead of throwing an Error
 * @param description
 * @param fn
 */
async function testAssertWorksSSAndFailsXS(description: string, fn:() => Promise<void>) {
    console.log(description + "...");
    if(isMainSite) {
        try {
            await assertRuns(fn);
            console.log(`...expectedly runs on main site`)
        }
        catch (e) {
            console.log(`...!!! failed on main site. See the following error:`)
            failTests(e);
        }
    }
    else {
        try {
            await assertFails(fn);
            console.log(`...expectedly fails cross site`)
        }
        catch (e) {
            console.log(`...!!! runs cross site but was expected to fail`)
            failTests(null);
        }
    }

}

function assertEquals<T>(actual: T, expected: T) {
    if(actual !== expected) {
        throw new Error(`Assertion failed: actual: ${actual}, expected: ${expected}`);
    }
}

function makeSimpleXhrRequest(method: string, url: string, body = ""): Promise<string> {


    return new Promise((resolve, reject)=> {
        try {
            const xhr = new XMLHttpRequest();
            xhr.open(method, url, true);
            xhr.setRequestHeader("Content-Type", "text/plain");
            xhr.withCredentials = true;
            xhr.onreadystatechange = function (this: XMLHttpRequest, ev: Event) {
                if (this.readyState == 4) {
                    if(this.status === 200) {
                        resolve("")
                    }
                    else {
                        reject(this.responseText)
                    }
                }
            };
            xhr.send(body);
        }
        catch (e) {
            reject(e);
        }
    })



}

export async function runAlltests() {
    failed = false;

    if(!isMainSite) {
        // cheap prevention of race condition if both browser windows reload at the same time:
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait a bit
    }

    const controlService = new RestfuncsClient<ControlService>(`${mainSiteUrl}/controlService`, {}).proxy


    // Test CORS and simple requests. All with "preflight" security:
    {
        await controlService.resetSession();

        const service = new RestfuncsClient<TestsService>(`${mainSiteUrl}/testsService`, {sessionCSRFProtection: "preflight"}).proxy
        const corsAllowedService = new RestfuncsClient<TestsService>(`${mainSiteUrl}/allowedTestsService`, {sessionCSRFProtection: "preflight"}).proxy

        /**
         * tests if runner successfully was able to spend money on bob's cookie-logged-in session.
         * @param runner
         */
        async function checkIfSpendsMoney(runner: () => Promise<void>) {
            await corsAllowedService.logon("bob"); // Logs in and give me some money
            assertEquals(await corsAllowedService.getBalance("bob"), 5000)
            let caught: any;
            try {
                await runner()
            } catch (e) {
                caught = e;
            }
            if (await corsAllowedService.getBalance("bob") !== 0) {
                throw new Error(`Money was not spent: ${caught?.message || caught || ""}`, {cause: caught});
            }
        }

        await testAssertWorksSSAndFailsXS("call test() on restricted service", async () => {
            assertEquals(await service.test(), "ok")
        });

        await testAssertWorksSSAndXS("call test() on allowed service", async () => {
            assertEquals(await corsAllowedService.test(), "ok")
        });

        // Simple requests:
        for (const method of ["GET", "POST"]) {
            await testAssertFailsSSAndXS(`Simple request on unsafe method (${method})`, async () => checkIfSpendsMoney(async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/testsService/unsafeMethod`)
            }));

            await testAssertWorksSSAndXS(`Simple request on safe method (${method})`, async () => checkIfSpendsMoney(async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/allowedTestsService/spendMoneyAccidentlyMarkedAsSafe`)
            }));
        }


        await testAssertWorksSSAndFailsXS("Spend money on restricted service", async () => checkIfSpendsMoney(async () => {
            await service.spendMoney();
        }));

        await testAssertWorksSSAndXS("Spend money on allowed service", async () => checkIfSpendsMoney(async () => {
            await corsAllowedService.spendMoney();
        }));


        // Test if we can spend money throug simple request (if they might get called but result can't be read)
        for (const method of ["GET", "POST"]) {
            // Test/Playground to see if makeSimpleXhrRequest really does make simple requests and if it's property detected. No real security indication
            await testAssertWorksSSAndFailsXS(`Simple request (${method})`, async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/testsService/getIsSimpleRequest`)
                assertEquals(await corsAllowedService.getLastCallWasSimpleRequest(), true);
            });
            await testAssertWorksSSAndXS(`Simple request (${method})`, async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/allowedTestsService/getIsSimpleRequest`, "xyz")
                assertEquals(await corsAllowedService.getLastCallWasSimpleRequest(), true);
            });

            //
            await testAssertWorksSSAndFailsXS(`Spend money on restricted service with simple request (${method})`, async () => checkIfSpendsMoney(async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/testsService/spendMoney`)
            }));

            await testAssertWorksSSAndXS(`Spend money on allowed service with simple request (${method})`, async () => checkIfSpendsMoney(async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/allowedTestsService/spendMoney`)
            }));
        }
    }


    // CorsReadToken: Automatic token fetch and re fetch:
    // Rather this should go into the normal restfuncs.test.ts. But we have lack of session support there
    await testAssertWorksSSAndXS(`Request with required token. Check if corsReadToken is fetched and re fetched automaticly`, async () => {
        await controlService.resetSession();
        // @ts-ignore
        const client = new RestfuncsClient<TestsService>(`${mainSiteUrl}/allowedTestsService_eraseOrigin`, {csrfProtectionMode: "corsReadToken"});
        const allowedService = client.proxy
        await allowedService.logon("bob");
        // @ts-ignore
        const getCurrentToken = ()=> client._corsReadToken
        // @ts-ignore
        const setCurrentToken = (value) => client._corsReadToken = value
        const valid = getCurrentToken();
        if(!valid) {
            throw new Error("Token has not beet set")
        }

        for(const invalidToken of [undefined, "abcWrongValue"]) {
            setCurrentToken(invalidToken);
            await allowedService.test();
            assertEquals(getCurrentToken(), invalidToken); // Expect it to be unchanged cause no session was accessed
            await allowedService.getBalance("bob");
            assertEquals(getCurrentToken(), valid); // The new token should have been fetched
        }

    });
    await testAssertWorksSSAndXS(`Copying corsReadToken from an allowed service to a restricted service should not work. Copying the proper one to the resrticted service should work`, async () => {
        await controlService.resetSession();

        // @ts-ignore
        const allowedClient = new RestfuncsClient<TestsService>(`${mainSiteUrl}/allowedTestsService_eraseOrigin`, {csrfProtectionMode: "corsReadToken"});
        const allowedService = allowedClient.proxy
        await allowedService.logon("bob");

        const restrictedClient = new RestfuncsClient<TestsService>(`${mainSiteUrl}/testsService`, {csrfProtectionMode: "corsReadToken"});
        const restrictedService = restrictedClient.proxy;
        const loginOnRestrictedService = async () => { await restrictedService.logon("bob");}

        if(isMainSite) {
            await loginOnRestrictedService();
        }
        else {
            await assertFails(loginOnRestrictedService)
        }

        // Copy the one from allowed service:
        // @ts-ignore
        restrictedClient._corsReadToken = allowedClient._corsReadToken
        // @ts-ignore
        if(!restrictedClient._corsReadToken) throw new Error("should not be unset")
        // Should still fail:
        if(isMainSite) {
            await loginOnRestrictedService();
        }
        else {
            await assertFails(loginOnRestrictedService)
        }

        // Obtain a valid one by cheating:
        // @ts-ignore
        restrictedClient._corsReadToken = controlService.getCorsReadTokenForService("testsService")
        await loginOnRestrictedService(); // now this should work
        assertEquals(await restrictedService.getBalance("bob"), 5000);
    });

    // CSRFToken:
    for(const serviceName of ["testsService","allowedTestsService"]) {
        await testAssertWorksSSAndXS(`Check if no/wrong csrfToken is rejected and proper token is accepted for ${serviceName}`, async () => {
            await controlService.resetSession();
            // @ts-ignore
            const client = new RestfuncsClient<TestsService>(`${mainSiteUrl}/${serviceName}`, {csrfProtectionMode: "csrfToken"});
            const service = client.proxy
            // no token:
            await assertFails(async () => {
                await service.logon("bob")
            })
            // wrong token:
            client.csrfToken = "wrongValue"
            await assertFails(async () => {
                await service.logon("bob")
            })

            // right token:
            client.csrfToken = await controlService.getCsrfTokenForService(serviceName);
            await service.logon("bob");
            assertEquals(await service.getBalance("bob"), 5000);

            // right token but from wrong service:
            client.csrfToken = await controlService.getCsrfTokenForService("mainframeAPI");
            await assertFails(async () => {await service.logon("bob")});
        });
    }


    // Test the "collision" of different csrfProtection modes:
    {
        for (const mode1 of ["preflight", "corsReadToken", "csrfToken"]) {
            for (const mode2 of ["preflight", "corsReadToken", "csrfToken"]) {
                if (mode1 == mode2) {
                    await testAssertWorksSSAndXS(`Requests from same session protection modes with forceTokenCheck, (${mode1} )`, async () => {
                        await controlService.resetSession();

                        for (const mode of [mode1, mode2]) {
                            // @ts-ignore
                            const corsAllowedService = new RestfuncsClient<TestsService>(`${mainSiteUrl}/allowedTestsService_forceTokenCheck`, {csrfProtectionMode: mode}).proxy
                            await corsAllowedService.test();
                        }
                    });

                    await testAssertWorksSSAndXS(`Requests from different session protection modes with session access, (${mode1} )`, async () => {
                        await controlService.resetSession();

                        // @ts-ignore
                        const corsAllowedService1 = new RestfuncsClient<TestsService>(`${mainSiteUrl}/allowedTestsService`, {csrfProtectionMode: mode1}).proxy
                        await corsAllowedService1.logon("bob");

                        // @ts-ignore
                        const corsAllowedService2 = new RestfuncsClient<TestsService>(`${mainSiteUrl}/allowedTestsService`, {csrfProtectionMode: mode2}).proxy
                        assertEquals(await corsAllowedService2.getBalance("bob"), 5000);
                    });

                } else {
                    for (const method of ["GET", "POST"]) {
                        await testAssertWorksSSAndXS(`Requests from different session protection modes but without session access, (simple ${method} ${mode1} vs restfuncs-client ${mode2} )`, async () => {
                            await controlService.resetSession();

                            await makeSimpleXhrRequest(method, `${mainSiteUrl}/allowedTestsService/test?csrfProtectionMode=${mode1}`)
                            // @ts-ignore
                            const corsAllowedService = new RestfuncsClient<TestsService>(`${mainSiteUrl}/allowedTestsService`, {csrfProtectionMode: mode2}).proxy
                            await corsAllowedService.test();

                            await makeSimpleXhrRequest(method, `${mainSiteUrl}/allowedTestsService/test`) // unspecified
                        });
                    }


                    await testAssertWorksSSAndXS(`Requests from different session protection modes with forceTokenCheck, (${mode1} vs ${mode2} )`, async () => {
                        await controlService.resetSession();

                        {
                            // @ts-ignore
                            const corsAllowedService = new RestfuncsClient<TestsService>(`${mainSiteUrl}/allowedTestsService_forceTokenCheck`, {csrfProtectionMode: mode1}).proxy
                            await corsAllowedService.test();
                        }
                        {
                            // @ts-ignore
                            const corsAllowedService = new RestfuncsClient<TestsService>(`${mainSiteUrl}/allowedTestsService_forceTokenCheck`, {csrfProtectionMode: mode2}).proxy
                            await assertFails(async () => {
                                await corsAllowedService.test();
                            })
                        }

                    });

                    await testAssertWorksSSAndXS(`Requests from different session protection modes with session access, (${mode1} vs ${mode2} )`, async () => {
                        await controlService.resetSession();

                        // @ts-ignore
                        const corsAllowedService1 = new RestfuncsClient<TestsService>(`${mainSiteUrl}/allowedTestsService`, {csrfProtectionMode: mode1}).proxy
                        await corsAllowedService1.logon("bob");

                        // @ts-ignore
                        const corsAllowedService2 = new RestfuncsClient<TestsService>(`${mainSiteUrl}/allowedTestsService`, {csrfProtectionMode: mode2}).proxy
                        await assertFails(async () => {await corsAllowedService2.getBalance("bob") });
                    });


                }

            }
        }
    }

    return !failed;
}
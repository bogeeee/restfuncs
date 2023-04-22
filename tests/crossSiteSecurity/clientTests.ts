import {RestfuncsClient, restfuncsClient} from "restfuncs-client"
import {TestsService} from "./TestsService";
import {MainframeService} from "./MainframeService";

export const mainSiteUrl = "http://localhost:3000";
export const isMainSite = window.location.href.startsWith(mainSiteUrl);
let failed = false;

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
        failed = true;
        console.log(`...!!! runs but was expected to fail`)
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
        failed = true;
        console.log(`...!!! unexpectedly failed ${isMainSite?"": "cross site. See the following error:"}`)
        console.error(e);
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
            failed = true;
            console.log(`...!!! failed on main site. See the following error:`)
            console.error(e);
        }
    }
    else {
        try {
            await assertFails(fn);
            console.log(`...expectedly fails cross site`)
        }
        catch (e) {
            failed = true;
            console.log(`...!!! runs cross site but was expected to fail`)
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
        await new Promise(resolve => setTimeout(resolve, 500)); // Wait a bit
    }

    const service = new RestfuncsClient<TestsService>( `${mainSiteUrl}/testsService`).proxy
    const corsAllowedService = new RestfuncsClient<TestsService>( `${mainSiteUrl}/allowedTestsService`).proxy

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
        }
        catch (e) {
            caught = e;
        }
        if(await corsAllowedService.getBalance("bob") !== 0) {
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
    for(const method of ["GET", "POST"]) {
        await testAssertFailsSSAndXS(`Simple request on unsafe method (${method})`, async () => checkIfSpendsMoney(async () => {
            await makeSimpleXhrRequest(method, `${mainSiteUrl}/testsService/unsafeMethod`)
        }));

        await testAssertWorksSSAndXS(`Simple request on safe method (${method})`, async () => checkIfSpendsMoney(async () => {
            await makeSimpleXhrRequest(method, `${mainSiteUrl}/allowedTestsService/spendMoneyAccidentlyMarkedAsSafe`)
        }));
    }


    await testAssertWorksSSAndFailsXS("Spend money on restricted service", async() => checkIfSpendsMoney(async () => {
        await service.spendMoney();
    }));

    await testAssertWorksSSAndXS("Spend money on allowed service", async() => checkIfSpendsMoney(async () => {
        await corsAllowedService.spendMoney();
    }));


    // Test if we can spend money throug simple request (if they might get called but result can't be read)
    for(const method of ["GET", "POST"]){
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
        await testAssertWorksSSAndFailsXS(`Spend money on restricted service with simple request (${method})`, async() => checkIfSpendsMoney(async () => {
            await makeSimpleXhrRequest(method, `${mainSiteUrl}/testsService/spendMoney`)
        }));

        await testAssertWorksSSAndXS(`Spend money on allowed service with simple request (${method})`, async() => checkIfSpendsMoney(async () => {
            await makeSimpleXhrRequest(method, `${mainSiteUrl}/allowedTestsService/spendMoney`)
        }));
    }


    return !failed;
}
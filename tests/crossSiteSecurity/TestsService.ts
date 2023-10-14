import {ServerSession, safe, ServerSessionOptions} from "restfuncs-server";
import fs from "node:fs"
import _ from "underscore";

export class TestServiceSessionBase extends ServerSession {
    user?: string;
    bankAccounts?: Record<string, number>;
}

export class TestsService extends TestServiceSessionBase {

    unsafeMethod() {
        return "test"
    }

    async logon(user: string) {
        this.user = user;

        if(!this.bankAccounts) this.bankAccounts = {} // initialize

        // give user some money:
        this.bankAccounts[this.user] = 5000;
    }

    async spendMoney() {
        if(!this.user) {
            throw new Error("Not logged it");
        }

        if(!this.bankAccounts) this.bankAccounts = {} // initialize. We need a better session concept from restfuncs

        this.bankAccounts[this.user] = 0;
    }


    @safe()
    async spendMoneyAccidentlyMarkedAsSafe() {
        if(!this.user) {
            throw new Error("Not logged it");
        }


        if(!this.bankAccounts) this.bankAccounts = {} // initialize. We need a better session concept from restfuncs

        this.bankAccounts[this.user] = 0;
    }

    async getBalance(user: string) {
        if(!this.user) {
            throw new Error("Not logged it");
        }

        if(!this.bankAccounts) this.bankAccounts = {} // initialize. We need a better session concept from restfuncs

        return this.bankAccounts[this.user];
    }


    async test() {
        return "ok";
    }


    static lastCallWasSimpleRequest = false;

    getLastCallWasSimpleRequest() {
        return TestsService.lastCallWasSimpleRequest;
    }

    getIsSimpleRequest(body?: string) {
        return isSimpleRequest(this.req)
    }

    getTestImage() {
        this.res?.contentType("image/x-png")
        return fs.createReadStream("teeest.png")
    }

    protected async doCall(funcName: string, args: any[]): Promise<any> {
        try {
            return super.doCall(funcName, args);
        }
        finally {
            TestsService.lastCallWasSimpleRequest = isSimpleRequest(this.req);
        }
    }
}


/**
 *  Copied from server/index.ts
 * @param req
 */
function isSimpleRequest(req: any) {
    /**
     *
     * @param contentType I.e. text/plain;charset=UTF-8
     * @return Would result into ["text/plain", {charset: "UTF-8"}]
     */
    function parseContentTypeHeader(contentType?: string): [string | undefined, Record<string, string>] {
        const attributes: Record<string, string> = {};

        if(!contentType) {
            return [undefined, attributes];
        }
        const tokens = contentType.split(";");
        for (const token of tokens.slice(1)) {
            if (!token || token.trim() == "") {
                continue;
            }
            if (token.indexOf("=") > -1) {
                const [key, value] = token.split("=");
                if (key) {
                    attributes[key.trim()] = value?.trim();
                }
            }
        }

        return [tokens[0], attributes]
    }


    const [contentType] = parseContentTypeHeader(req.header("Content-Type"));
    return (req.method === "GET" || req.method === "HEAD" || req.method === "POST") &&
        (contentType === "application/x-www-form-urlencoded" || contentType === "multipart/form-data" || contentType === "text/plain") && req.header("IsComplex") !== "true"

}
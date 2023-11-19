import {ServerSession, ServerSessionOptions, remote} from "restfuncs-server";
import fs from "node:fs"
import _ from "underscore";
import {couldBeSimpleRequest} from "restfuncs-server/Util";

export class TestServiceSessionBase extends ServerSession {
    user?: string;
    bankAccounts?: Record<string, number>;
}

export class TestsService extends TestServiceSessionBase {

    @remote()
    unsafeMethod() {
        return "test"
    }

    @remote()
    async logon(user: string) {
        this.user = user;

        if(!this.bankAccounts) this.bankAccounts = {} // initialize

        // give user some money:
        this.bankAccounts[this.user] = 5000;
    }

    @remote()
    async spendMoney() {
        if(!this.user) {
            throw new Error("Not logged it");
        }

        if(!this.bankAccounts) this.bankAccounts = {} // initialize. We need a better session concept from restfuncs

        this.bankAccounts[this.user] = 0;
    }


    @remote({isSafe: true})
    async spendMoneyAccidentlyMarkedAsSafe() {
        if(!this.user) {
            throw new Error("Not logged it");
        }


        if(!this.bankAccounts) this.bankAccounts = {} // initialize. We need a better session concept from restfuncs

        this.bankAccounts[this.user] = 0;
    }

    @remote()
    async getBalance(user: string) {
        if(!this.user) {
            throw new Error("Not logged it");
        }

        if(!this.bankAccounts) this.bankAccounts = {} // initialize. We need a better session concept from restfuncs

        return this.bankAccounts[this.user];
    }


    @remote()
    async test() {
        return "ok";
    }


    static lastCallWasSimpleRequest?: boolean


    @remote()
    getLastCallWasSimpleRequest() {
        return TestsService.lastCallWasSimpleRequest;
    }

    @remote()
    getIsSimpleRequest(body?: string) {
        if (!this.call.req) {
            throw new Error("getIsSimpleRequest not called via http")
        }
        return couldBeSimpleRequest(this.call.req)
    }

    @remote()
    getTestImage() {
        this.call.res?.contentType("image/x-png")
        return fs.createReadStream("teeest.png")
    }

    protected async doCall(funcName: string, args: any[]): Promise<any> {
        try {
            return super.doCall(funcName, args);
        } finally {
            TestsService.lastCallWasSimpleRequest = this.call.req ? couldBeSimpleRequest(this.call.req) : undefined;
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
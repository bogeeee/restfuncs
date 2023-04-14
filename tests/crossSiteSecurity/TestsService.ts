import {RestService} from "restfuncs-server";
import _ from "underscore";

const bankAccounts: Record<string, number> = {};

export class TestsService extends RestService {
    session: {
        user?: string
    } = {}

    logon(user: string) {
        this.session.user = user;

        // give user some money:
        bankAccounts[this.session.user] = 5000;
    }

    spendMoney() {
        if(!this.session.user) {
            throw new Error("Not logged it");
        }

        bankAccounts[this.session.user] = 0;
    }

    getBalance(user: string) {
        return bankAccounts[this.session.user];
    }


    async test() {
        return "ok";
    }

    /**
     *
     */
    async getTest() {
       return "ok"
    }
}
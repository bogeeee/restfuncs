import {RestService} from "restfuncs-server";
import _ from "underscore";

export class TestsService extends RestService {

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
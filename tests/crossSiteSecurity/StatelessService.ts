import {RestService} from "restfuncs-server";
import _ from "underscore";

/**
 * Stateless means: No login / session is needed
 */
export class StatelessService extends RestService {

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
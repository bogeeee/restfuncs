import {shieldTokenAgainstBREACH, shieldTokenAgainstBREACH_unwrap} from "restfuncs-server/Util";

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible


test('shieldTokenAgainstBREACH', async () => {
    function checkConsistant(value: string) {
        const buffer = Buffer.from(value, "utf8");
        expect(shieldTokenAgainstBREACH_unwrap(shieldTokenAgainstBREACH(buffer)).toString("utf8")).toBe(value);
    }

    expect(shieldTokenAgainstBREACH(Buffer.from(""))).toBe("--");
    checkConsistant("")
    checkConsistant("0")
    checkConsistant("abcdef")
});
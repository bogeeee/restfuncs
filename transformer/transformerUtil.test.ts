import {TextPatch} from "./transformerUtil";

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible


test('TextPatch', () => {
    const content='abc><de><fg'
    const patch = new TextPatch();
    patch.patches = [{position: 4, contentToInsert: "_insert1_"}, {position: 8, contentToInsert: "_insert2_"}];
    expect(patch.applyPatches(content)).toBe('abc>_insert1_<de>_insert2_<fg');
});


import {DropConcurrentOperation} from "./Util";

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible


describe('DropConcurrentOperation', () => {
    let singleRetryableOperation: DropConcurrentOperation<unknown>;

    beforeEach(() => {
        singleRetryableOperation = new DropConcurrentOperation();
    });

    it('should execute the operation and return the result', async () => {
        const operation = jest.fn().mockResolvedValue('Success');
        const result = await singleRetryableOperation.exec(operation);
        expect(result).toEqual('Success');
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should return the same promise for multiple simultaneous exec calls', async () => {
        const operation = jest.fn().mockResolvedValue('Success');

        const promise1 = singleRetryableOperation.exec(operation);
        const promise2 = singleRetryableOperation.exec(operation);

        const [result1, result2] = await Promise.all([promise1, promise2]);

        expect(result1).toEqual('Success');
        expect(result2).toEqual('Success');
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should throw an error and allow retry for the next call', async () => {
        const operation = jest.fn().mockRejectedValueOnce(new Error('Failure')).mockResolvedValue('Success');

        let error;
        try {
            await singleRetryableOperation.exec(operation);
        } catch (e) {
            error = e;
        }

        expect(error).toEqual(new Error('Failure'));
        expect(operation).toHaveBeenCalledTimes(1);

        // Now retry
        const mockSuccessOperation = jest.fn().mockResolvedValue('Success');
        const result = await singleRetryableOperation.exec(mockSuccessOperation);
        expect(result).toEqual('Success');
        expect(operation).toHaveBeenCalledTimes(1);
        expect(mockSuccessOperation).toHaveBeenCalledTimes(1);
    });
});
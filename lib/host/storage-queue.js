//#region src/host/storage-queue.ts
/** One process-wide serial queue shared by all taskboard persistence. */
var StorageQueue = class {
	tail = Promise.resolve();
	run(operation) {
		const result = this.tail.then(operation, operation);
		this.tail = result.then(() => void 0, () => void 0);
		return result;
	}
};
//#endregion
export { StorageQueue };

//# sourceMappingURL=storage-queue.js.map
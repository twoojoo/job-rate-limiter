import Redis from "ioredis"

/**
 * TODO??: add grace mechanism: 
 * if 3 seconds are missing before the window
 * expires, the just wait for it
 * 
 * */

export type LimiterError = {
	limitError: true,
	scope: "namespace" | "key"
	namespace: string
	key: number | string,
	kind?: string,
	expireAt?: number
	type: "maxConcurrentJobs" | "maxJobsPerTimestamp" | "maxItemsPerTimespan"
}

export type LimiterRules = {
	namespace?: Rules,
	keyspace?: Rules,
}

export type Rules = {
	maxJobsPerTimestamp?: {
		global: {
			count: number,
			timespan: number
		}, 
		kinds: {
			[kind: string]: {
				count: number,
				timespan: number
			}
		},
	}
	maxItemsPerTimespan?: {
		global: {
			count: number,
			timespan: number
		}, 
		kinds: {
			[kind: string]: {
				count: number,
				timespan: number
			}
		},
	},
	maxConcurrentJobs?: {
		global?: number
		kinds?: { [kind: string]: number }
	}
}

export type LimitOptions = {
	kind: string,
	itemsCount?: number
}


/**Provides a stateful rate limiting layer for incoming jobs
 * 
 * @jobs can be used as wrapper around the job function through the .exec() method.
 * 
 * @Redis limits are shared between different instances using Redis as stateful storage.
 * 
 * @note every instance that shares the same redis connection, namespace and rules acts as a single instance (even when working on different machines)*/

export class Limiter {
	private defaultOpts: Partial<LimitOptions> = {}
	private bypassLimits = false

	constructor(
		private redis: Redis, 
		private namespace: string,
		private rules: LimiterRules
	) {}

	private keyGenerators = {
		maxItemsPerTimespan: {
			namespace: (kind?: string) => `rl-mppt-${this.namespace}${"-" + kind || ""}`,
			keyspace: (key: string | number, kind?: string) => `rl-mppt-${key}${kind || ""}`
		},
		maxJobsPerTimespan: {
			namespace: (kind?: string) => `rl-mrpt-${this.namespace}${"-" + kind || ""}`,
			keyspace: (key: string | number, kind?: string) => `rl-mrpt-${key}${"-" + kind || ""}`
		},
		maxConcurrentJobs: {
			namespace: (kind?: string) => `rl-mcr-${this.namespace}${"-" + kind || ""}`,
			keyspace: (key: string | number, kind?: string) => `rl-mcr-${key}${"-" + kind || ""}`
		}
	};

	/**ignore limits check*/
	bypass() {
		this.bypassLimits = true
		return this
	}

	/**ignore limits check*/
	unsetBypass() {
		this.bypassLimits = false
		return this
	}

	/**Execute an action according to limits provided in the class constructor (if no limits are passed, the just execute the action)
	 * 
	 * @return the callback result if limits are not execeeded
	 * @throw a custom error if limits are exceeded (and don't execute the action) - error will be an object with isLimiterError: true*/
	async exec<T>(key: number | string, opts: LimitOptions, callback: () => Promise<T>): Promise<T> {
		opts = { ...this.defaultOpts, ...opts }

		if (!this.bypassLimits) {
			const redisActions: (() => Promise<any>)[] = []
		
			////////// THESE METHODS THROW AN ERROR WHEN EXECEEDING LIMITS!!! ///////////
			await this.checkNamespaceMaxConcurrentJobsGlobal(redisActions, key)
			await this.checkNamespaceMaxConcurrentJobsPerKind(redisActions, key, opts.kind)
			await this.checkNamespaceMaxJobsPerTimespanGlobal(redisActions, key)
			await this.checkNamespaceMaxJobsPerTimespanPerKind(redisActions, key, opts.kind)

			await this.checkKeyMaxConcurrentJobsGlobal(redisActions, key)
			await this.checkKeyMaxConcurrentJobsPerKind(redisActions, key, opts.kind)
			await this.checkKeyMaxJobsPerTimespanGlobal(redisActions, key)
			await this.checkKeyMaxJobsPerTimespanPerKind(redisActions, key, opts.kind)

			if (opts.itemsCount !== null && opts.itemsCount !== undefined) {
				await this.checkNamespaceMaxItemsPerTimespanGlobal(redisActions, key, opts.itemsCount)
				await this.checkNamespaceMaxItemsPerTimespanPerKind(redisActions, key, opts.kind, opts.itemsCount)
				
				await this.checkKeyMaxItemsPerTimespanGlobal(redisActions, key, opts.itemsCount)
				await this.checkKeyMaxItemsPerTimespanPerKind(redisActions, key, opts.kind, opts.itemsCount)
			}

			////////////////////////////////////////////////////////////////////////////
			
			await Promise.allSettled(redisActions.map(a => a()))	
		}

		const result = await callback()

		if (!this.bypassLimits) { 
			await this.resetConcurrencyLimits(key, opts.kind)
		}

		return result
			
	}
		
	private async resetConcurrencyLimits(key: string | number, kind: string) {
		await this.unregisterNamespaceJobGlobal()
		await this.unregisterKeyJobGlobal(key)
		await this.unregisterNamespaceKind(kind)
		await this.unregisterKeyKind(key, kind)
	}

	private async checkNamespaceMaxJobsPerTimespanGlobal(redisActions: (() => Promise<any>)[], key: string | number) {
		if (this.rules?.namespace?.maxJobsPerTimestamp?.global) {
			const rKey = this.keyGenerators.maxJobsPerTimespan.namespace()
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxJobsPerTimestamp!.global!.count) {
				throw this.buildError({
					scope: "namespace",
					type: "maxJobsPerTimestamp",
					key,
					expireAt: undefined //TODO
				})
			} 	

			const TTLms = this.rules!.namespace!.maxJobsPerTimestamp!.global!.timespan

			redisActions.push(count == 0
				? async () => {
					console.log(rKey, count + 1, TTLms) 
					await this.redis.set(rKey, count + 1, "PX", TTLms)
				}
				: async () => await this.redis.set(rKey, count + 1, "KEEPTTL")
			)
		}
	}

	private async checkKeyMaxJobsPerTimespanGlobal(redisActions: (() => Promise<any>)[], key: string | number) {
		if (this.rules?.keyspace?.maxJobsPerTimestamp?.global) {
			const rKey = this.keyGenerators.maxJobsPerTimespan.keyspace(key)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.keyspace!.maxJobsPerTimestamp!.global!.count) {
				throw this.buildError({
					scope: "key",
					key,
					type: "maxJobsPerTimestamp",
					expireAt: undefined //TODO
				})
			} 	

			const TTLms = this.rules!.keyspace!.maxJobsPerTimestamp!.global!.timespan

			redisActions.push(count == 0
				? async () => await this.redis.set(rKey, count + 1, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + 1, "KEEPTTL")
			)

			return true
		}
	}

	private async checkNamespaceMaxJobsPerTimespanPerKind(redisActions: (() => Promise<any>)[], key: string | number, kind: string) {
		if (this.rules?.namespace?.maxJobsPerTimestamp?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxJobsPerTimespan.namespace(kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxJobsPerTimestamp!.kinds![kind]!.count) {
				throw this.buildError({
					scope: "namespace",
					kind,
					key,
					type: "maxJobsPerTimestamp",
					expireAt: undefined //TODO
				})
			} 	

			const TTLms = this.rules!.namespace!.maxJobsPerTimestamp!.global!.timespan

			redisActions.push(count == 0
				? async () => {
					console.log(rKey, count + 1, TTLms) 
					await this.redis.set(rKey, count + 1, "PX", TTLms)
				}
				: async () => await this.redis.set(rKey, count + 1, "KEEPTTL")
			)
		}
	}

	private async checkKeyMaxJobsPerTimespanPerKind(redisActions: (() => Promise<any>)[], key: string | number, kind: string) {
		if (this.rules?.keyspace?.maxJobsPerTimestamp?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxJobsPerTimespan.keyspace(kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxJobsPerTimestamp!.kinds![kind]!.count) {
				throw this.buildError({
					scope: "namespace",
					type: "maxJobsPerTimestamp",
					kind,
					key,
					expireAt: undefined //TODO
				})
			} 	

			const TTLms = this.rules!.keyspace!.maxJobsPerTimestamp!.global!.timespan

			redisActions.push(count == 0
				? async () => await this.redis.set(rKey, count + 1, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + 1, "KEEPTTL")
			)

			return true
		}
	}

	private async checkNamespaceMaxItemsPerTimespanGlobal(redisActions: (() => Promise<any>)[], key: string | number, itemsCount: number) {
		if (this.rules?.namespace?.maxItemsPerTimespan?.global) {
			const rKey = this.keyGenerators.maxItemsPerTimespan.namespace()
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxItemsPerTimespan!.global!.count) {
				throw this.buildError({
					scope: "namespace",
					type: "maxItemsPerTimespan",
					key,
					expireAt: undefined //TODO
				})
			} 	

			const TTLms = this.rules!.namespace!.maxItemsPerTimespan!.global!.timespan

			redisActions.push(count == 0
				? async () => await this.redis.set(rKey, count + itemsCount!, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + itemsCount!, "KEEPTTL")
			)
		}
	}

	private async checkNamespaceMaxItemsPerTimespanPerKind(redisActions: (() => Promise<any>)[], key: string | number, kind: string, itemsCount: number) {
		if (this.rules?.namespace?.maxItemsPerTimespan?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxItemsPerTimespan.namespace(kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxItemsPerTimespan!.kinds![kind]!.count) {
				throw this.buildError({
					scope: "namespace",
					type: "maxItemsPerTimespan",
					kind,
					key,
					expireAt: undefined //TODO
				})
			} 	

			const TTLms = this.rules!.namespace!.maxItemsPerTimespan!.kinds![kind]!.timespan

			redisActions.push(count == 0
				? async () => await this.redis.set(rKey, count + itemsCount!, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + itemsCount!, "KEEPTTL")
			)
		}
	}

	private async checkKeyMaxItemsPerTimespanPerKind(redisActions: (() => Promise<any>)[], key: string | number, kind: string, itemsCount: number) {
		if (this.rules?.keyspace?.maxItemsPerTimespan?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxItemsPerTimespan.keyspace(key, kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.keyspace!.maxItemsPerTimespan!.kinds![kind]!.count) {
				throw this.buildError({
					scope: "key",
					kind,
					type: "maxItemsPerTimespan",
					key,
					expireAt: undefined //TODO
				})
			}

			const TTLms = this.rules!.keyspace!.maxItemsPerTimespan!.kinds![kind]!.timespan

			redisActions.push(count == 0
				? async () => await this.redis.set(rKey, count + itemsCount!, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + itemsCount!, "KEEPTTL")
			)
		}
	}

	private async checkKeyMaxItemsPerTimespanGlobal(redisActions: (() => Promise<any>)[], key: string | number, itemsCount: number) {
		if (this.rules?.keyspace?.maxItemsPerTimespan?.global) {
			const rKey = this.keyGenerators.maxItemsPerTimespan.keyspace(key)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.keyspace!.maxItemsPerTimespan!.global?.count) {
				throw this.buildError({
					scope: "key",
					type: "maxItemsPerTimespan",
					key,
					expireAt: undefined //TODO
				})
			}

			const TTLms = this.rules!.keyspace!.maxItemsPerTimespan!.global!.timespan

			redisActions.push(count == 0
				? async () => await this.redis.set(rKey, count + itemsCount!, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + itemsCount!, "KEEPTTL")
			)
		}
	}

	private async checkNamespaceMaxConcurrentJobsGlobal(redisActions: (() => Promise<any>)[], key: string | number) {
		if (this.rules?.namespace?.maxConcurrentJobs?.global) {
			const rKey = this.keyGenerators.maxConcurrentJobs.namespace()
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxConcurrentJobs!.global!) {
				throw this.buildError({
					scope: "namespace",
					key,
					type: "maxConcurrentJobs"
				})
			} 

			redisActions.push(async () => await this.redis.set(rKey, count + 1))
		}
	}

	private async checkKeyMaxConcurrentJobsGlobal(redisActions: (() => Promise<any>)[], key: string | number) {
		if (this.rules?.keyspace?.maxConcurrentJobs?.global) {
			const rKey = this.keyGenerators.maxConcurrentJobs.keyspace(key)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.keyspace!.maxConcurrentJobs!.global!) {
				throw this.buildError({
					scope: "key",
					key,
					type: "maxConcurrentJobs"
				})
			} 

			redisActions.push(async () => await this.redis.set(rKey, count + 1))
		}
	}

	private async checkNamespaceMaxConcurrentJobsPerKind(redisActions: (() => Promise<any>)[], key: string | number, kind: string) {
		if (this.rules?.namespace?.maxConcurrentJobs?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxConcurrentJobs.namespace(kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxConcurrentJobs!.kinds![kind]) {
				throw this.buildError({
					scope: "namespace",
					kind: kind,
					key,
					type: "maxConcurrentJobs"
				})
			} 

			redisActions.push(async () => await this.redis.set(rKey, count + 1))
		}
	}

	private async checkKeyMaxConcurrentJobsPerKind(redisActions: (() => Promise<any>)[], key: string | number, kind: string) {
		if (this.rules?.namespace?.maxConcurrentJobs?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxConcurrentJobs.keyspace(key, kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxConcurrentJobs!.kinds![kind]) {
				throw this.buildError({
					scope: "namespace",
					kind: kind,
					key,
					type: "maxConcurrentJobs"
				})
			} 

			redisActions.push(async () => await this.redis.set(rKey, count + 1))
		}
	}

	private async unregisterNamespaceKind(kind: string): Promise<void> {
		if (this.rules?.namespace?.maxConcurrentJobs?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxConcurrentJobs.namespace(kind)
			const count = parseInt(await this.redis.get(rKey) || "0")
			await this.redis.set(rKey, count == 0 ? 0 : count - 1)
		}
	}

	private async unregisterKeyKind(key: string | number, kind: string): Promise<void> {
		if (this.rules?.keyspace?.maxConcurrentJobs?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxConcurrentJobs.keyspace(key, kind)
			const count = parseInt(await this.redis.get(rKey) || "0")
			await this.redis.set(rKey, count == 0 ? 0 : count - 1)
		}
	}

	private async unregisterNamespaceJobGlobal(): Promise<void> {
		if (this.rules?.namespace?.maxConcurrentJobs?.global) {
			const rKey = this.keyGenerators.maxConcurrentJobs.namespace()
			const count = parseInt(await this.redis.get(rKey) || "0")
			await this.redis.set(rKey, count == 0 ? 0 : count - 1)
		}
	}

	private async unregisterKeyJobGlobal(key: string | number): Promise<void> {
		if (this.rules?.keyspace?.maxConcurrentJobs?.global) {
			const rKey = this.keyGenerators.maxConcurrentJobs.keyspace(key)
			const count = parseInt(await this.redis.get(rKey) || "0")
			await this.redis.set(rKey, count == 0 ? 0 : count - 1)
		}
	}

	private buildError(error: Omit<LimiterError, 'limitError' | 'namespace'>): LimiterError {
		(error as LimiterError).limitError = true;
		(error as LimiterError).namespace = this.namespace;
		// (error as LimiterError).key = key;
		return error as LimiterError
	}
}
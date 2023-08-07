import Redis from "ioredis"

/**
 * TODO??: add grace mechanism: 
 * if 3 seconds are missing before the window
 * expires, the just wait for it
 * 
 * */

type Without<T, U> = { [P in Exclude<keyof T, keyof U>]?: never };
type XOR<T, U> = (T | U) extends object ? (Without<T, U> & U) | (Without<U, T> & T) : T | U;

export type LimiterError = {
	// limitError: true,
	scope: "namespace" | "key"
	namespace: string
	key: number | string,
	kind?: string,
	expiresIn?: number
	type: "maxConcurrentJobs" | "maxJobsPerTimespan" | "maxItemsPerTimespan"
}

export type LimiterRules = {
	namespace?: Rules,
	keyspace?: Rules,
}

export type Rules = {
	maxJobsPerTimespan?: {
		global?: {
			count: number,
			timespan: number
		}, 
		kinds?: {
			[kind: string]: {
				count: number,
				timespan: number
			}
		},
	}
	maxItemsPerTimespan?: {
		global?: {
			count: number,
			timespan: number
		}, 
		kinds?: {
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
	kind?: string,
	items?: number
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
			keyspace: (key: string | number, kind?: string) => `rl-mppt-${this.namespace}-${key}${kind || ""}`
		},
		maxJobsPerTimespan: {
			namespace: (kind?: string) => `rl-mrpt-${this.namespace}${"-" + kind || ""}`,
			keyspace: (key: string | number, kind?: string) => `rl-mrpt-${this.namespace}-${key}${"-" + kind || ""}`
		},
		maxConcurrentJobs: {
			namespace: (kind?: string) => `rl-mcr-${this.namespace}${"-" + kind || ""}`,
			keyspace: (key: string | number, kind?: string) => `rl-mcr-${this.namespace}-${key}${"-" + kind || ""}`
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
	async exec<T>(key: number | string, callback: () => Promise<T>, opts: LimitOptions = {}): Promise<[null, LimiterError] | [T, null]> {
		opts = { ...this.defaultOpts, ...opts }

		if (!this.bypassLimits) {
			const redisActions: (() => Promise<any>)[] = []
			let err: void | LimiterError

			err = await this.checkNamespaceMaxConcurrentJobsGlobal(redisActions, key)
			if (err) return [null, err]

			err = await this.checkNamespaceMaxJobsPerTimespanGlobal(redisActions, key)
			if (err) return [null, err]

			err = await this.checkKeyMaxConcurrentJobsGlobal(redisActions, key)
			if (err) return [null, err]

			err = await this.checkKeyMaxJobsPerTimespanGlobal(redisActions, key)
			if (err) return [null, err]

			if (opts.items !== null && opts.items !== undefined) {
				err = await this.checkNamespaceMaxItemsPerTimespanGlobal(redisActions, key, opts.items)
				if (err) return [null, err]

				err = await this.checkKeyMaxItemsPerTimespanGlobal(redisActions, key, opts.items)
				if (err) return [null, err]

				if (opts.kind) {
					err = await this.checkNamespaceMaxItemsPerTimespanPerKind(redisActions, key, opts.kind, opts.items)
					if (err) return [null, err]

					err = await this.checkKeyMaxItemsPerTimespanPerKind(redisActions, key, opts.kind, opts.items)
					if (err) return [null, err]
				}
			}

			if (opts.kind) {
				err = await this.checkKeyMaxJobsPerTimespanPerKind(redisActions, key, opts.kind)
				if (err) return [null, err]

				err = await this.checkKeyMaxConcurrentJobsPerKind(redisActions, key, opts.kind)
				if (err) return [null, err]

				err = await this.checkNamespaceMaxConcurrentJobsPerKind(redisActions, key, opts.kind)
				if (err) return [null, err]

				err = await this.checkNamespaceMaxJobsPerTimespanPerKind(redisActions, key, opts.kind)
				if (err) return [null, err]
			}

			////////////////////////////////////////////////////////////////////////////
			
			await Promise.allSettled(redisActions.map(a => a()))	
		}

		const result = await callback()

		if (!this.bypassLimits) { 
			await this.resetConcurrencyLimits(key, opts.kind)
		}

		return [result, null]
	}
		
	private async resetConcurrencyLimits(key: string | number, kind?: string) {
		await this.unregisterNamespaceJobGlobal()
		await this.unregisterKeyJobGlobal(key)

		if (kind) {
			await this.unregisterNamespaceKind(kind)
			await this.unregisterKeyKind(key, kind)
		}
	}

	private async checkNamespaceMaxJobsPerTimespanGlobal(redisActions: (() => Promise<any>)[], key: string | number): Promise<void | LimiterError> {
		if (this.rules?.namespace?.maxJobsPerTimespan?.global) {
			const rKey = this.keyGenerators.maxJobsPerTimespan.namespace()
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxJobsPerTimespan!.global!.count) {
				return this.buildError({
					scope: "namespace",
					type: "maxJobsPerTimespan",
					key,
					expiresIn: await this.getExpiresIn(rKey),
				})
			} 	

			const TTLms = this.rules!.namespace!.maxJobsPerTimespan!.global!.timespan

			redisActions.push(count == 0
				? async () => await this.redis.set(rKey, count + 1, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + 1, "KEEPTTL")
			)
		}
	}

	private async checkKeyMaxJobsPerTimespanGlobal(redisActions: (() => Promise<any>)[], key: string | number): Promise<void | LimiterError> {
		if (this.rules?.keyspace?.maxJobsPerTimespan?.global) {
			const rKey = this.keyGenerators.maxJobsPerTimespan.keyspace(key)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.keyspace!.maxJobsPerTimespan!.global!.count) {
				return this.buildError({
					scope: "key",
					key,
					type: "maxJobsPerTimespan",
					expiresIn: await this.getExpiresIn(rKey),
				})
			} 	

			const TTLms = this.rules!.keyspace!.maxJobsPerTimespan!.global!.timespan

			redisActions.push(count == 0
				? async () => await this.redis.set(rKey, count + 1, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + 1, "KEEPTTL")
			)
		}
	}

	private async checkNamespaceMaxJobsPerTimespanPerKind(redisActions: (() => Promise<any>)[], key: string | number, kind: string): Promise<void | LimiterError> {
		if (this.rules?.namespace?.maxJobsPerTimespan?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxJobsPerTimespan.namespace(kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxJobsPerTimespan!.kinds![kind]!.count) {
				return this.buildError({
					scope: "namespace",
					kind,
					key,
					type: "maxJobsPerTimespan",
					expiresIn: await this.getExpiresIn(rKey),
				})
			} 	

			const TTLms = this.rules!.namespace!.maxJobsPerTimespan!.global!.timespan

			redisActions.push(count == 0
				? async () => {
					console.log(rKey, count + 1, TTLms) 
					await this.redis.set(rKey, count + 1, "PX", TTLms)
				}
				: async () => await this.redis.set(rKey, count + 1, "KEEPTTL")
			)
		}
	}

	private async checkKeyMaxJobsPerTimespanPerKind(redisActions: (() => Promise<any>)[], key: string | number, kind: string): Promise<void | LimiterError> {
		if (this.rules?.keyspace?.maxJobsPerTimespan?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxJobsPerTimespan.keyspace(kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxJobsPerTimespan!.kinds![kind]!.count) {
				return this.buildError({
					scope: "namespace",
					type: "maxJobsPerTimespan",
					expiresIn: await this.getExpiresIn(rKey),
					kind,
					key,
				})
			} 	

			const TTLms = this.rules!.keyspace!.maxJobsPerTimespan!.global!.timespan

			redisActions.push(count == 0
				? async () => await this.redis.set(rKey, count + 1, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + 1, "KEEPTTL")
			)
		}
	}

	private async checkNamespaceMaxItemsPerTimespanGlobal(redisActions: (() => Promise<any>)[], key: string | number, itemsCount: number): Promise<void | LimiterError> {
		if (this.rules?.namespace?.maxItemsPerTimespan?.global) {
			const rKey = this.keyGenerators.maxItemsPerTimespan.namespace()
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxItemsPerTimespan!.global!.count) {
				return this.buildError({
					scope: "namespace",
					type: "maxItemsPerTimespan",
					expiresIn: await this.getExpiresIn(rKey),
					key,
				})
			} 	

			const TTLms = this.rules!.namespace!.maxItemsPerTimespan!.global!.timespan

			redisActions.push(count == 0
				? async () => await this.redis.set(rKey, count + itemsCount!, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + itemsCount!, "KEEPTTL")
			)
		}
	}

	private async checkNamespaceMaxItemsPerTimespanPerKind(redisActions: (() => Promise<any>)[], key: string | number, kind: string, itemsCount: number): Promise<void | LimiterError> {
		if (this.rules?.namespace?.maxItemsPerTimespan?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxItemsPerTimespan.namespace(kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxItemsPerTimespan!.kinds![kind]!.count) {
				return this.buildError({
					scope: "namespace",
					type: "maxItemsPerTimespan",
					kind,
					key,
					expiresIn: await this.getExpiresIn(rKey),
				})
			} 	

			const TTLms = this.rules!.namespace!.maxItemsPerTimespan!.kinds![kind]!.timespan

			redisActions.push(count == 0
				? async () => await this.redis.set(rKey, count + itemsCount!, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + itemsCount!, "KEEPTTL")
			)
		}
	}

	private async checkKeyMaxItemsPerTimespanPerKind(redisActions: (() => Promise<any>)[], key: string | number, kind: string, itemsCount: number): Promise<void | LimiterError> {
		if (this.rules?.keyspace?.maxItemsPerTimespan?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxItemsPerTimespan.keyspace(key, kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.keyspace!.maxItemsPerTimespan!.kinds![kind]!.count) {
				return this.buildError({
					scope: "key",
					kind,
					type: "maxItemsPerTimespan",
					key,
					expiresIn: await this.getExpiresIn(rKey),
				})
			}

			const TTLms = this.rules!.keyspace!.maxItemsPerTimespan!.kinds![kind]!.timespan

			redisActions.push(count == 0
				? async () => await this.redis.set(rKey, count + itemsCount!, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + itemsCount!, "KEEPTTL")
			)
		}
	}

	private async checkKeyMaxItemsPerTimespanGlobal(redisActions: (() => Promise<any>)[], key: string | number, itemsCount: number): Promise<void | LimiterError> {
		if (this.rules?.keyspace?.maxItemsPerTimespan?.global) {
			const rKey = this.keyGenerators.maxItemsPerTimespan.keyspace(key)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.keyspace!.maxItemsPerTimespan!.global?.count) {
				return this.buildError({
					scope: "key",
					type: "maxItemsPerTimespan",
					key,
					expiresIn: await this.getExpiresIn(rKey),
				})
			}

			const TTLms = this.rules!.keyspace!.maxItemsPerTimespan!.global!.timespan

			redisActions.push(count == 0
				? async () => await this.redis.set(rKey, count + itemsCount!, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + itemsCount!, "KEEPTTL")
			)
		}
	}

	private async checkNamespaceMaxConcurrentJobsGlobal(redisActions: (() => Promise<any>)[], key: string | number): Promise<void | LimiterError> {
		if (this.rules?.namespace?.maxConcurrentJobs?.global) {
			const rKey = this.keyGenerators.maxConcurrentJobs.namespace()
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxConcurrentJobs!.global!) {
				return this.buildError({
					scope: "namespace",
					key,
					type: "maxConcurrentJobs"
				})
			} 

			redisActions.push(async () => await this.redis.set(rKey, count + 1))
		}
	}

	private async checkKeyMaxConcurrentJobsGlobal(redisActions: (() => Promise<any>)[], key: string | number): Promise<void | LimiterError> {
		if (this.rules?.keyspace?.maxConcurrentJobs?.global) {
			const rKey = this.keyGenerators.maxConcurrentJobs.keyspace(key)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.keyspace!.maxConcurrentJobs!.global!) {
				return this.buildError({
					scope: "key",
					key,
					type: "maxConcurrentJobs"
				})
			} 

			redisActions.push(async () => await this.redis.set(rKey, count + 1))
		}
	}

	private async checkNamespaceMaxConcurrentJobsPerKind(redisActions: (() => Promise<any>)[], key: string | number, kind: string): Promise<void | LimiterError> {
		if (this.rules?.namespace?.maxConcurrentJobs?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxConcurrentJobs.namespace(kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxConcurrentJobs!.kinds![kind]) {
				return this.buildError({
					scope: "namespace",
					kind: kind,
					key,
					type: "maxConcurrentJobs"
				})
			} 

			redisActions.push(async () => await this.redis.set(rKey, count + 1))
		}
	}

	private async checkKeyMaxConcurrentJobsPerKind(redisActions: (() => Promise<any>)[], key: string | number, kind: string): Promise<void | LimiterError> {
		if (this.rules?.namespace?.maxConcurrentJobs?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxConcurrentJobs.keyspace(key, kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxConcurrentJobs!.kinds![kind]) {
				return this.buildError({
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
		// (error as LimiterError).limitError = true;
		(error as LimiterError).namespace = this.namespace;
		// (error as LimiterError).key = key;
		return error as LimiterError
	}

	private async getExpiresIn(redisKey: string) {
		const ttl = await this.redis.pttl(redisKey)
		if (ttl == -1) return 0 // means no TTL -> should throw an error?
		if (ttl == -2) return 0 // means no key -> should throw an error?
		return ttl
	}
}
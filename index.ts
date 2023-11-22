import Redis from "ioredis"
import Redlock, { Settings, Lock } from "redlock";

/**
 * TODO??: add grace mechanism: 
 * if 3 seconds are missing before the window
 * expires, the just wait for it
 * 
 * */

type RedisAction = (() => Promise<any>)

type Without<T, U> = { [P in Exclude<keyof T, keyof U>]?: never };
type XOR<T, U> = (T | U) extends object ? (Without<T, U> & U) | (Without<U, T> & T) : T | U;

export type LimiterError = {
	limiterId: string,
	type: "maxConcurrentJobs" | "maxJobsPerTimespan" | "maxItemsPerTimespan"
	scope: "namespace" | "key"
	namespace: string
	key: number | string,
	global: boolean,
	kind?: string, // only if provided 
	expiresIn?: number // only for maxJobsPerTimespan and maxItemsPerTimespan
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
	private redlock: Redlock
	private lockDuration: number

	constructor(
		private id: string,
		private redis: Redis,
		private rules: LimiterRules,
		redislockOptions?: Partial<Settings> & { lockDuration?: number }
	) {
		this.lockDuration = redislockOptions?.lockDuration || 5000
		this.redlock = new Redlock([redis], redislockOptions)
	}

	private keyGenerators = {
		maxItemsPerTimespan: {
			namespace: (ns: string, kind?: string) => `rl-mppt-${this.id}-${ns}${"-" + kind || ""}`,
			keyspace: (ns: string, key: string | number, kind?: string) => `rl-mppt-${this.id}-${ns}-${key}${kind || ""}`
		},
		maxJobsPerTimespan: {
			namespace: (ns: string, kind?: string) => `rl-mrpt-${this.id}-${ns}${"-" + kind || ""}`,
			keyspace: (ns: string, key: string | number, kind?: string) => `rl-mrpt-${this.id}-${ns}-${key}${"-" + kind || ""}`
		},
		maxConcurrentJobs: {
			namespace: (ns: string, kind?: string) => `rl-mcr-${this.id}-${ns}${"-" + kind || ""}`,
			keyspace: (ns: string, key: string | number, kind?: string) => `rl-mcr-${this.id}-${ns}-${key}${"-" + kind || ""}`
		}
	};

	private getAllKeys(ns: string, key: string, kind?: string): string[] {
		return [
			this.keyGenerators.maxItemsPerTimespan.namespace(ns, kind),
			this.keyGenerators.maxItemsPerTimespan.keyspace(ns, key),
			this.keyGenerators.maxJobsPerTimespan.namespace(ns, kind),
			this.keyGenerators.maxJobsPerTimespan.keyspace(ns, key),
			this.keyGenerators.maxConcurrentJobs.namespace(ns, kind),
			this.keyGenerators.maxConcurrentJobs.keyspace(ns, key),
		]
	}

	/**Execute an action according to limits provided in the class constructor (if no limits are passed, the just execute the action)
	 * 
	 * @return the callback result if limits are not execeeded
	 * @throw a custom error if limits are exceeded (and don't execute the action) - error will be an object with isLimiterError: true*/
	async exec<T>(namespace: string, key: number | string, callback: () => Promise<T>, opts: LimitOptions = {}): Promise<[null, LimiterError] | [T, null]> {
		opts = { ...this.defaultOpts, ...opts }

		// Aquiring Redis Lock on all involved keys
		const keys = this.getAllKeys(namespace, key.toString(), opts.kind)
		let lock = await this.redlock.acquire(keys, this.lockDuration!) 

		const rActions: RedisAction[] = []
		let err: void | LimiterError

		//check global limits (no kind)
		err = await this.checkNamespaceMaxConcurrentJobsGlobal(rActions, namespace, key, opts.kind)
		if (err) return [null, err]

		err = await this.checkNamespaceMaxJobsPerTimespanGlobal(rActions, namespace, key, opts.kind)
		if (err) return [null, err]

		err = await this.checkKeyMaxConcurrentJobsGlobal(rActions, namespace, key, opts.kind)
		if (err) return [null, err]

		err = await this.checkKeyMaxJobsPerTimespanGlobal(rActions, namespace, key, opts.kind)
		if (err) return [null, err]

		// check limits on items count parameter
		if (opts.items !== null && opts.items !== undefined) {
			err = await this.checkNamespaceMaxItemsPerTimespanGlobal(rActions, namespace, key, opts.items, opts.kind)
			if (err) return [null, err]

			err = await this.checkKeyMaxItemsPerTimespanGlobal(rActions, namespace, key, opts.items, opts.kind)
			if (err) return [null, err]

			if (opts.kind) {
				err = await this.checkNamespaceMaxItemsPerTimespanPerKind(rActions, namespace, key, opts.kind, opts.items)
				if (err) return [null, err]

				err = await this.checkKeyMaxItemsPerTimespanPerKind(rActions, namespace, key, opts.kind, opts.items)
				if (err) return [null, err]
			}
		}

		// check limits on kind parameter
		if (opts.kind) {
			err = await this.checkKeyMaxJobsPerTimespanPerKind(rActions, namespace, key, opts.kind)
			if (err) return [null, err]

			err = await this.checkKeyMaxConcurrentJobsPerKind(rActions, namespace, key, opts.kind)
			if (err) return [null, err]

			err = await this.checkNamespaceMaxConcurrentJobsPerKind(rActions, namespace, key, opts.kind)
			if (err) return [null, err]

			err = await this.checkNamespaceMaxJobsPerTimespanPerKind(rActions, namespace, key, opts.kind)
			if (err) return [null, err]
		}
			
		//All updates on counters are executed at the same time so that 
		//counters get updated only if the job gets actually done
		await Promise.allSettled(rActions.map(a => a()))	

		// Releasing locks before processing job
		await lock.release()

		const result = await callback()

		// Aquiring Redis Lock on all involved keys
		lock = await this.redlock.acquire(keys, 5000) 
		await this.resetConcurrencyLimits(namespace, key, opts.kind)
		await lock.release()

		return [result, null]
	}
		
	private async resetConcurrencyLimits(ns: string, key: string | number, kind?: string) {
		await this.unregisterNamespaceJobGlobal(ns)
		await this.unregisterKeyJobGlobal(ns, key)

		if (kind) {
			await this.unregisterNamespaceKind(ns, kind)
			await this.unregisterKeyKind(ns, key, kind)
		}
	}

	private async checkNamespaceMaxJobsPerTimespanGlobal(rActions: RedisAction[], ns: string, key: string | number, kind?: string): Promise<void | LimiterError> {
		if (this.rules?.namespace?.maxJobsPerTimespan?.global) {
			const rKey = this.keyGenerators.maxJobsPerTimespan.namespace(ns, ns)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxJobsPerTimespan!.global!.count) {
				return this.buildError({
					scope: "namespace",
					type: "maxJobsPerTimespan",
					key,
					global: true,
					namespace: ns,
					expiresIn: await this.getExpiresIn(rKey),
					kind,
				})
			} 	

			const TTLms = this.rules!.namespace!.maxJobsPerTimespan!.global!.timespan

			rActions.push(count == 0
				? async () => await this.redis.set(rKey, count + 1, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + 1, "KEEPTTL")
			)
		}
	}

	private async checkKeyMaxJobsPerTimespanGlobal(rActions: RedisAction[], ns: string, key: string | number, kind?: string): Promise<void | LimiterError> {
		if (this.rules?.keyspace?.maxJobsPerTimespan?.global) {
			const rKey = this.keyGenerators.maxJobsPerTimespan.keyspace(ns, key)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.keyspace!.maxJobsPerTimespan!.global!.count) {
				return this.buildError({
					scope: "key",
					key,
					namespace: ns,
					global: true,
					type: "maxJobsPerTimespan",
					expiresIn: await this.getExpiresIn(rKey),
					kind,
				})
			} 	

			const TTLms = this.rules!.keyspace!.maxJobsPerTimespan!.global!.timespan

			rActions.push(count == 0
				? async () => await this.redis.set(rKey, count + 1, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + 1, "KEEPTTL")
			)
		}
	}

	private async checkNamespaceMaxJobsPerTimespanPerKind(rActions: RedisAction[], ns: string, key: string | number, kind: string): Promise<void | LimiterError> {
		if (this.rules?.namespace?.maxJobsPerTimespan?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxJobsPerTimespan.namespace(ns, kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxJobsPerTimespan!.kinds![kind]!.count) {
				return this.buildError({
					scope: "namespace",
					kind,
					key,
					namespace: ns,
					global: false,
					type: "maxJobsPerTimespan",
					expiresIn: await this.getExpiresIn(rKey),
				})
			} 	

			const TTLms = this.rules!.namespace!.maxJobsPerTimespan!.global!.timespan

			rActions.push(count == 0
				? async () => {
					console.log(rKey, count + 1, TTLms) 
					await this.redis.set(rKey, count + 1, "PX", TTLms)
				}
				: async () => await this.redis.set(rKey, count + 1, "KEEPTTL")
			)
		}
	}

	private async checkKeyMaxJobsPerTimespanPerKind(rActions: RedisAction[], ns: string, key: string | number, kind: string): Promise<void | LimiterError> {
		if (this.rules?.keyspace?.maxJobsPerTimespan?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxJobsPerTimespan.keyspace(ns, kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxJobsPerTimespan!.kinds![kind]!.count) {
				return this.buildError({
					scope: "namespace",
					type: "maxJobsPerTimespan",
					namespace: ns,
					global: false,
					expiresIn: await this.getExpiresIn(rKey),
					kind,
					key,
				})
			} 	

			const TTLms = this.rules!.keyspace!.maxJobsPerTimespan!.global!.timespan

			rActions.push(count == 0
				? async () => await this.redis.set(rKey, count + 1, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + 1, "KEEPTTL")
			)
		}
	}

	private async checkNamespaceMaxItemsPerTimespanGlobal(rActions: RedisAction[], ns: string, key: string | number, itemsCount: number, kind?: string): Promise<void | LimiterError> {
		if (this.rules?.namespace?.maxItemsPerTimespan?.global) {
			const rKey = this.keyGenerators.maxItemsPerTimespan.namespace(ns,)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxItemsPerTimespan!.global!.count) {
				return this.buildError({
					scope: "namespace",
					type: "maxItemsPerTimespan",
					expiresIn: await this.getExpiresIn(rKey),
					namespace: ns,
					global: true,
					key,
					kind,
				})
			} 	

			const TTLms = this.rules!.namespace!.maxItemsPerTimespan!.global!.timespan

			rActions.push(count == 0
				? async () => await this.redis.set(rKey, count + itemsCount!, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + itemsCount!, "KEEPTTL")
			)
		}
	}

	private async checkNamespaceMaxItemsPerTimespanPerKind(rActions: RedisAction[], ns: string, key: string | number, kind: string, itemsCount: number): Promise<void | LimiterError> {
		if (this.rules?.namespace?.maxItemsPerTimespan?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxItemsPerTimespan.namespace(ns, kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxItemsPerTimespan!.kinds![kind]!.count) {
				return this.buildError({
					scope: "namespace",
					type: "maxItemsPerTimespan",
					kind,
					key,
					expiresIn: await this.getExpiresIn(rKey),
					namespace: ns,
					global: false,
				})
			} 	

			const TTLms = this.rules!.namespace!.maxItemsPerTimespan!.kinds![kind]!.timespan

			rActions.push(count == 0
				? async () => await this.redis.set(rKey, count + itemsCount!, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + itemsCount!, "KEEPTTL")
			)
		}
	}

	private async checkKeyMaxItemsPerTimespanPerKind(rActions: RedisAction[], ns: string, key: string | number, kind: string, itemsCount: number): Promise<void | LimiterError> {
		if (this.rules?.keyspace?.maxItemsPerTimespan?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxItemsPerTimespan.keyspace(ns, key, kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.keyspace!.maxItemsPerTimespan!.kinds![kind]!.count) {
				return this.buildError({
					scope: "key",
					kind,
					type: "maxItemsPerTimespan",
					key,
					expiresIn: await this.getExpiresIn(rKey),
					namespace: ns,
					global: false,
				})
			}

			const TTLms = this.rules!.keyspace!.maxItemsPerTimespan!.kinds![kind]!.timespan

			rActions.push(count == 0
				? async () => await this.redis.set(rKey, count + itemsCount!, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + itemsCount!, "KEEPTTL")
			)
		}
	}

	private async checkKeyMaxItemsPerTimespanGlobal(rActions: RedisAction[], ns: string, key: string | number, itemsCount: number, kind?: string): Promise<void | LimiterError> {
		if (this.rules?.keyspace?.maxItemsPerTimespan?.global) {
			const rKey = this.keyGenerators.maxItemsPerTimespan.keyspace(ns, key)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.keyspace!.maxItemsPerTimespan!.global?.count) {
				return this.buildError({
					scope: "key",
					type: "maxItemsPerTimespan",
					key,
					expiresIn: await this.getExpiresIn(rKey),
					global: true,
					namespace: ns,
					kind,
				})
			}

			const TTLms = this.rules!.keyspace!.maxItemsPerTimespan!.global!.timespan

			rActions.push(count == 0
				? async () => await this.redis.set(rKey, count + itemsCount!, "PX", TTLms)
				: async () => await this.redis.set(rKey, count + itemsCount!, "KEEPTTL")
			)
		}
	}

	private async checkNamespaceMaxConcurrentJobsGlobal(rActions: RedisAction[], ns: string, key: string | number, kind?: string): Promise<void | LimiterError> {
		if (this.rules?.namespace?.maxConcurrentJobs?.global) {
			const rKey = this.keyGenerators.maxConcurrentJobs.namespace(ns,)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxConcurrentJobs!.global!) {
				return this.buildError({
					scope: "namespace",
					key,
					type: "maxConcurrentJobs",
					global: true,
					namespace: ns,
					kind,
				})
			} 

			rActions.push(async () => await this.redis.set(rKey, count + 1))
		}
	}

	private async checkKeyMaxConcurrentJobsGlobal(rActions: RedisAction[], ns: string, key: string | number, kind?: string): Promise<void | LimiterError> {
		if (this.rules?.keyspace?.maxConcurrentJobs?.global) {
			const rKey = this.keyGenerators.maxConcurrentJobs.keyspace(ns, key)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.keyspace!.maxConcurrentJobs!.global!) {
				return this.buildError({
					scope: "key",
					key,
					namespace: ns,
					type: "maxConcurrentJobs",
					global: true,
					kind,
				})
			} 

			rActions.push(async () => await this.redis.set(rKey, count + 1))
		}
	}

	private async checkNamespaceMaxConcurrentJobsPerKind(rActions: RedisAction[], ns: string, key: string | number, kind: string): Promise<void | LimiterError> {
		if (this.rules?.namespace?.maxConcurrentJobs?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxConcurrentJobs.namespace(ns, kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxConcurrentJobs!.kinds![kind]) {
				return this.buildError({
					scope: "namespace",
					kind: kind,
					key,
					namespace: ns,
					type: "maxConcurrentJobs",
					global: false,
				})
			} 

			rActions.push(async () => await this.redis.set(rKey, count + 1))
		}
	}

	private async checkKeyMaxConcurrentJobsPerKind(rActions: RedisAction[], ns: string, key: string | number, kind: string): Promise<void | LimiterError> {
		if (this.rules?.namespace?.maxConcurrentJobs?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxConcurrentJobs.keyspace(ns, key, kind)
			const count = parseInt(await this.redis.get(rKey) || "0")

			if (count >= this.rules!.namespace!.maxConcurrentJobs!.kinds![kind]) {
				return this.buildError({
					scope: "namespace",
					kind: kind,
					key,
					namespace: ns,
					type: "maxConcurrentJobs",
					global: false,
				})
			} 

			rActions.push(async () => await this.redis.set(rKey, count + 1))
		}
	}

	private async unregisterNamespaceKind(ns: string, kind: string): Promise<void> {
		if (this.rules?.namespace?.maxConcurrentJobs?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxConcurrentJobs.namespace(ns, kind)
			const count = parseInt(await this.redis.get(rKey) || "0")
			await this.redis.set(rKey, count == 0 ? 0 : count - 1)
		}
	}

	private async unregisterKeyKind(ns: string, key: string | number, kind: string): Promise<void> {
		if (this.rules?.keyspace?.maxConcurrentJobs?.kinds?.[kind]) {
			const rKey = this.keyGenerators.maxConcurrentJobs.keyspace(ns, key, kind)
			const count = parseInt(await this.redis.get(rKey) || "0")
			await this.redis.set(rKey, count == 0 ? 0 : count - 1)
		}
	}

	private async unregisterNamespaceJobGlobal(ns: string): Promise<void> {
		if (this.rules?.namespace?.maxConcurrentJobs?.global) {
			const rKey = this.keyGenerators.maxConcurrentJobs.namespace(ns)
			const count = parseInt(await this.redis.get(rKey) || "0")
			await this.redis.set(rKey, count == 0 ? 0 : count - 1)
		}
	}

	private async unregisterKeyJobGlobal(ns: string, key: string | number): Promise<void> {
		if (this.rules?.keyspace?.maxConcurrentJobs?.global) {
			const rKey = this.keyGenerators.maxConcurrentJobs.keyspace(ns, key)
			const count = parseInt(await this.redis.get(rKey) || "0")
			await this.redis.set(rKey, count == 0 ? 0 : count - 1)
		}
	}

	private buildError(error: Omit<LimiterError, 'limiterId'>): LimiterError {
		(error as LimiterError).limiterId = this.id;
		return error as LimiterError
	}

	private async getExpiresIn(redisKey: string) {
		const ttl = await this.redis.pttl(redisKey)
		if (ttl == -1) return 0 // means no TTL -> should throw an error?
		if (ttl == -2) return 0 // means no key -> should throw an error?
		return ttl
	}
}
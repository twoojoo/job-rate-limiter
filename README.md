# Job Rate Limiter

A tiny job rate limiter that can handles complex situations using job namespace, key and kind (stateful through Redis).

### Use case example

You need to limit a series of jobs, let's say HTTP requests, while respecting these conditions:

- requests are sent to different servers exposing different APIs
- these servers have some limitations but don't have a proper rate limiter
- each server requires different rate limiting strategies
- for each sever, requests are sent for different API accounts
- for every account, requests may be of different kinds
- each request kind may require different rate limiting strategies
- you must be able to: 
	- limit concurrent requests
	- limit requests in a time window
	- limit items handled by requests in a time window
  - set different limits counters for each API (both server-wide and account-wide)
  - set different limits counters both for all requests kinds and for specific kinds (both server-wide and account-wide)
  - possibly run requests from more than one single client, but sharing limits counters (limiter state)

All these conditions can be handled via this library by

- using **jobs namespaces** to indicate different API servers
- using **jobs keys** to indicate different API accounts
- using **jobs kinds** to indicate the kind of request
- setting *rate limiting rules* for each of these scopes and for each kind of limit

### Basic usage

The following example shows how to set up a limiter in order to:

- execute 100 (fake) jobs
- allowing a maximum of 10 jobs in a 15 seconds time window (for the whole job namespace)
- when this limit is exceeded, retry after the provided expiration time of the window (or after 10 seconds)

```typescript
import { Limiter, LimiterRules } from "job-rate-limiter"
import { Redis } from "ioredis"

const rules: LimiterRules = {
	namespace: {
		maxJobsPerTimespan: {
			global: {
				count: 10, // max 10 jobs
				timespan: 15000 // per 15 sec
			}
		}
	}
}

const limiter = new Limiter(
	"limiter-id",
	new Redis("localhost:6379"),
	rules
);

(async function () {
	for (let i = 0; i < 100; i++) {

		const [result, err] = await limiter.exec("job-namespace", "job-key", async () => {
			await delay(1000) //simulating a 1 sec job 
			return "done" 
		})

		if (err) {
			console.error(new Date(), `! limit exceeded:`, err)

			await delay(err.expiresIn || 10000) //wait limit expiration

			i--	 // keep counter at the current job 
			continue // and retry
		}

		console.log(new Date(), `>`, i, result)

	}
})()

async function delay(ms: number) {
	return await new Promise<void>(resolve => setTimeout(() => resolve(), ms))
}
```

Expected output:

```shell
2023-08-07T16:08:07.668Z > 0 done
2023-08-07T16:08:08.675Z > 1 done
2023-08-07T16:08:09.678Z > 2 done
2023-08-07T16:08:10.680Z > 3 done
2023-08-07T16:08:11.683Z > 4 done
2023-08-07T16:08:12.689Z > 5 done
2023-08-07T16:08:13.692Z > 6 done
2023-08-07T16:08:14.695Z > 7 done
2023-08-07T16:08:15.697Z > 8 done
2023-08-07T16:08:16.698Z > 9 done
2023-08-07T16:08:16.699Z ! limit exceeded: {
  scope: 'namespace',
  type: 'maxJobsPerTimespan',
  key: 'job-key',
  global: true,
  namespace: 'job-namespace',
  expiresIn: 4967,
  kind: undefined,
  limiterId: 'limiter-id'
}
2023-08-07T16:08:22.675Z > 10 done
2023-08-07T16:08:23.677Z > 11 done
2023-08-07T16:08:24.679Z > 12 done
```

### Limits

- **maxJobsPerTimespan**: limits the number of jobs that can be executed in a time window
- **maxConcurrentJobs**: limits then number of jobs that can run in parallel
- **maxItemsPerTimespan**: limits the number of items that jobs can handle in a time window ([when provided](#jobs-items-limit))

#### Limits object breakdon

```typescript 
type LimiterRules = {
	namespace: { // works at the namespace level (same limits counter for each job key)
		maxJobsPerTimespan?: {
			global?: { // for all job kinds (or if kind is not specified)
				count: number,
				timespan: number // milliseconds
			}, 
			kinds?: { // for specific job kinds (when specified)
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
	},
	keyspace: { // works at the key level (different limits counters for each job key)
		/* same structure as namespace limits*/
	}
}
```

### Job kind

When a job kind is provided, limits can be applied to the kind itself (both at namespace and keyspace level):

```typescript
await limiter.exec("job-namespace", "job-key", async () => {
	// job of kind "example"
}, { kind: "example" })
```

### Jobs items limit

A limit can be set also for the total amount of items that a series of job can handle in a timespan. Since the limiter can't know how to calculate the amount of items that a job will handle, this value has to be passed as an option:

```typescript
await limiter.exec("job-namespace", "job-key", async () => {
	// job that handles 12 items
}, { items: 12 })
```

### Limiter error type 

When a limit is exceeded, an error is thrown in the form of an object that has the following type:

```typescript
type LimiterError = {
	limiterId: string,
	type: "maxConcurrentJobs" | "maxJobsPerTimespan" | "maxItemsPerTimespan"
	scope: "namespace" | "key"
	namespace: string
	key: number | string,
	global: boolean,
	kind?: string, // only if provided 
	expiresIn?: number // only for maxJobsPerTimespan and maxItemsPerTimespan
}
```
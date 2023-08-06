# Job Rate Limiter

Tiny job rate limiter (stateful through Redis) that can handles complex situations using job namespaces, keys and kinds.

## Basic usage

The following example shows how to set up a limiter in order to:

- execute 100 (fake) jobs
- allowing a maximum of 10 jobs in a 15 seconds time window (for the whole job namespace)
- when this limit is exceeded, retry after the provided expiration time of the window (or after 10 seconds)

```typescript
import { Limiter, LimiterRules, isLimiterError } from "job-rate-limiter"
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
	new Redis("localhost:6379"),
	"job-namespace",
	rules
);

(async function () {
	for (let i = 0; i < 100; i++) {
		try {
			//simulating a 1 second long job 
			const result = await limiter.exec("job-key", async () => {
				await delay(1000)
				return "done" 
			})

			console.log(new Date(), `#>`, i, result)
		} catch (err) {
			if (isLimiterError(err)) {
				console.error(new Date(), `!> limit exceeded:`, err)
				await delay(err.expiresIn || 10000)
				i-- // to retry the current job
			}
			else throw err
		}
	}
})()

async function delay(ms: number) {
	return await new Promise<void>(resolve => setTimeout(() => resolve(), ms))
}
```

Expected output:

```bash
2023-08-05T16:01:08.209Z #> 0 done
2023-08-05T16:01:09.214Z #> 1 done
2023-08-05T16:01:10.217Z #> 2 done
2023-08-05T16:01:11.221Z #> 3 done
2023-08-05T16:01:12.224Z #> 4 done
2023-08-05T16:01:13.231Z #> 5 done
2023-08-05T16:01:14.234Z #> 6 done
2023-08-05T16:01:15.237Z #> 7 done
2023-08-05T16:01:16.239Z #> 8 done
2023-08-05T16:01:17.241Z #> 9 done
2023-08-05T16:01:17.243Z !> limit exceeded: {
  scope: 'namespace',
  type: 'maxJobsPerTimespan',
  key: 'job-key',
  expiresIn: 4964,
  limitError: true,
  namespace: 'job-namespace'
}
2023-08-05T16:01:23.218Z #> 10 done
2023-08-05T16:01:24.221Z #> 11 done
2023-08-05T16:01:25.224Z #> 12 done
```

## Limits

- **maxJobsPerTimespan**: limits the number of jobs that can be executed in a time window
- **maxConcurrentJobs**: limits then number of jobs that can run in parallel
- **maxItemsPerTimespan**: limits the number of item that jobs can handle in a time window ([when provided](#jobs-items-limit))

### Limits object breakdon

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

## Job kind

When a job kind is provided, limits can be applied to the kind itself (both at namespace and keyspace level):

```typescript
await limiter.exec("job-key", async () => {
		// job of kind "example"
	}, { kind: "example" })
```

## Jobs items limit

A limit can be set also for the total amount of items a series of job can handle in a timespan. Since the limiter can't know how to calculate the amount of items that a job will handle, this value has to be passed as an option:

```typescript
await limiter.exec("job-key", async () => {
		// job that handles 12 items
	}, { items: 12 })
```

# Job Rate Limiter

Job rate limiter (stateful through Redis) that can handles complex situations using job namespaces, keys and kinds.

## Basic usage
```typescript
import { Limiter, LimiterRules, isLimitError } from "job-rate-limiter"
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
			//simulating a long job 
			const result = await limiter.exec("job-key", async () => {
				await delay(1000) // 1sec
				return "done" 
			})

			console.log(new Date(), `#>`, i, result)
		} catch (err) {
			if (isLimitError(err)) {
				console.error(new Date(), `!> limit exceeded:`, err)
				await delay(err.expiresIn || 10000)
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
2023-08-05T16:01:23.218Z #> 11 done
2023-08-05T16:01:24.221Z #> 12 done
2023-08-05T16:01:25.224Z #> 13 done
```

## Limits

- **maxJobsPerTimespan**: limits the number of jobs that can be executed in a time window
- **maxConcurrentJobs**: limits then number of jobs that can run in parallel
- **maxItemsPerTimespan**: limits the number of item that jobs can handle in a time window

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
		/* same */
	}
}
```
# Job Rate Limiter

## Usage
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
2023-08-05T15:57:37.791Z #> 0 done
2023-08-05T15:57:38.797Z #> 1 done
2023-08-05T15:57:39.801Z #> 2 done
2023-08-05T15:57:40.804Z #> 3 done
2023-08-05T15:57:41.808Z #> 4 done
2023-08-05T15:57:42.814Z #> 5 done
2023-08-05T15:57:43.818Z #> 6 done
2023-08-05T15:57:44.820Z #> 7 done
2023-08-05T15:57:45.821Z #> 8 done
2023-08-05T15:57:46.823Z #> 9 done
2023-08-05T15:57:46.825Z !> limit exceeded: {
  scope: 'namespace',
  type: 'maxJobsPerTimestamp',
  key: 'job-key',
  expiresIn: 4966,
  limitError: true,
  namespace: 'job-namespace'
}
2023-08-05T15:57:52.801Z #> 11 done
2023-08-05T15:57:53.804Z #> 12 done
2023-08-05T15:57:54.808Z #> 13 done
```
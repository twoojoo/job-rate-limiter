# Job Rate Limiter

## Usage
```typescript
import { Limiter, LimiterRules, isLimitError } from "job-rate-limiter"
import { Redis } from "ioredis"

const rules: LimiterRules = {
	namespace: {
		maxJobsPerTimestamp: {
			global: {
				count: 10,
				timespan: 15 * 1000 // 1min
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
	return await new Promise<string>(r => setTimeout(() => r("done"), ms))
}
```

Expecte output:

```c++
2023-08-05T15:47:39.229Z #> 0 done
2023-08-05T15:47:40.233Z #> 1 done
2023-08-05T15:47:41.236Z #> 2 done
2023-08-05T15:47:42.239Z #> 3 done
2023-08-05T15:47:43.243Z #> 4 done
2023-08-05T15:47:44.249Z #> 5 done
2023-08-05T15:47:45.252Z #> 6 done
2023-08-05T15:47:46.255Z #> 7 done
2023-08-05T15:47:47.257Z #> 8 done
2023-08-05T15:47:48.259Z #> 9 done
2023-08-05T15:47:48.260Z !> limit exceeded: {
  scope: 'namespace',
  type: 'maxJobsPerTimestamp',
  key: 'job-key',
  expiresIn: undefined,
  limitError: true,
  namespace: 'job-namespace'
}
2023-08-05T15:47:59.276Z #> 11 done
2023-08-05T15:48:00.279Z #> 12 done
2023-08-05T15:48:01.282Z #> 13 done
2023-08-05T15:48:02.285Z #> 14 done
```
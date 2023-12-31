import { Limiter, LimiterRules } from "."
import { Redis } from "ioredis"

const rules: LimiterRules = {
	namespace: {
		maxJobsPerTimespan: {
			global: {
				count: 10,
				timespan: 15 * 1000
			}
		}
	}
}

const limiter = new Limiter(
	"limiter-id",
	new Redis("localhost:6379"),
	rules,
	{
		retryCount: 10,
		retryDelay: 200
	}
);


(async function () {
	for (let i = 0; i < 100; i++) {
		const [result, err] = await limiter.exec("job-namespace", "job-key", async () => {
			await delay(1000) //simulating a 1 sec job 
			return "done" 
		})

		if (err) {
			console.error(new Date(), `!> limit exceeded:`, err)
			await delay(err.expiresIn || 10000)
			i--			// keep counter to the current job 
			continue	// and retry
		}

		console.log(new Date(), `#>`, i, result)
	}
})()

async function delay(ms: number) {
	return await new Promise<string>(r => setTimeout(() => r("done"), ms))
}
import { Limiter, LimiterRules, isLimiterError } from "."
import { Redis } from "ioredis"

const rules: LimiterRules = {
	namespace: {
		maxJobsPerTimespan: {
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
			if (isLimiterError(err)) {
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
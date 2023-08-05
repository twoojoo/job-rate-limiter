import { Redis } from "ioredis"
import { Limiter, LimiterRules } from "."

const rules: LimiterRules = {
	namespace: {
		
	}
}

const limiter = new Limiter(
	new Redis("localhost:6379"),
	"my-namespace",
	rules
)
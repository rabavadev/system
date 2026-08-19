# Behavioral Eval Runner Contract

These files are **behavior contracts**, not fake claims that a model was already benchmarked.

A real runner should execute each task against:
1. baseline agent without the target skill,
2. agent with the target skill available/forced as appropriate.

The runner records:
```json
{
  "skill": "canonical-implementation",
  "case_id": "canonical-implementation-positive-1",
  "triggered": true,
  "observed_outcomes": {
    "leave one active dashboard and one current-user source": true,
    "migrate consumers before cleanup": true
  },
  "forbidden_outcomes": {
    "create DashboardV3": false
  }
}
```

`grade_behavior_eval.py` scores that result deterministically.

The pack deliberately does not hardcode one model/provider API into the eval harness.

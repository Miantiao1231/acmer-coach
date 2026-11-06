// An opted-in launch shell must not connect ordinary tests to its real memory bank.
process.env.COACH_HINDSIGHT = '0'
// 普通测试不联网；外部源单测自己传 env/fetch。
process.env.COACH_EXTERNAL_SOURCES = '0'
process.env.COACH_BACKGROUND_LLM = '0'

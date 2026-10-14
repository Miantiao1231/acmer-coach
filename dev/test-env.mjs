// An opted-in launch shell must not connect ordinary tests to its real memory bank.
process.env.COACH_HINDSIGHT = '0'

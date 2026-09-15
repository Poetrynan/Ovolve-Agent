from team import check_result_contract
ok, problems = check_result_contract({"summary": 123}, {"required": ["summary"], "types": {"summary": str}})
print("ok:", ok)
print("problems:", problems)

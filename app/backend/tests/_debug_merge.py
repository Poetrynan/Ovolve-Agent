from work_copy import describe_merge_status
result = {"applied": [], "deleted": [], "conflicts": {}, "errors": [{"path": "a.py"}]}
print("result:", describe_merge_status(result))
print("applied falsy:", not result.get("applied"))
print("errors truthy:", bool(result.get("errors")))

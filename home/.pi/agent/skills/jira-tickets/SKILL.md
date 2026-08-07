---
name: make-jira-tickets
description: >-
  Use this skill when asked to make jira tickets. You will make a CSV for import into jira.
---

Review the plan/implementation document (or use the current session as context if there is no written plan) and break it out into jira tickets for me. There should be least one jia issue per phase, but break down phases where it's truly independent, shippable, work. Provide a JIRA-compatible csv with columns for:

- Title
- Description (make sure this is comprehensive of the work)
- Issue Type (options are Feature, Research, Task)
- Assignee (use git config email for the current repo unless otherwise instructed)
- Parent Link (if an epic has been provided for this work, it’s link can go here)
- Story Points (Fibonacci)

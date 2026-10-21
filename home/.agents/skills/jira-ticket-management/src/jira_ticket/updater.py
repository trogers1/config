"""Existing-ticket reads and partial edits, independent of creation defaults.

Every prepare_update call is read-only. Mutation calls are deliberately sequential,
never retried, and use the established immutable issue ID, not its mutable key.
"""
from decimal import Decimal

from .core import Creator, Failure, issue_reference, points_value
from . import sprints


FIELD_SCHEMA = {'project': 'project', 'issuetype': 'issuetype', 'summary': 'string',
                'description': 'string', 'assignee': 'user', 'reporter': 'user',
                'parent': 'issuelink', 'customfield_10004': 'number'}
SUPPORTED = 'summary,description,project,issuetype,status,assignee,reporter,parent,customfield_10004,issuelinks'


def numeric_id(value):
    return isinstance(value, (str, int)) and not isinstance(value, bool) and str(value).isascii() and str(value).isdigit()


def equal_field(name, observed, expected):
    if isinstance(expected, dict) and name != 'description':
        attr = 'accountId' if name in ('assignee', 'reporter') else 'id'
        return isinstance(observed, dict) and str(observed.get(attr)) == str(expected[attr])
    return observed == expected


def selected_details(value, keys):
    return {key: value[key] for key in keys if key in value} if isinstance(value, dict) else None


class Updater(Creator):
    def read_issue(self, reference, *, all_fields=False):
        if not issue_reference(reference):
            raise Failure('Target must be an existing Jira key or numeric ID.')
        data = self.request('GET', 'issue/' + reference,
                            params={'fields': '*all' if all_fields else SUPPORTED})
        if (not isinstance(data, dict) or not isinstance(data.get('id'), str) or
                not data['id'].isascii() or not data['id'].isdigit() or
                not issue_reference(data.get('key')) or '-' not in data['key'] or
                not isinstance(data.get('fields'), dict)):
            raise Failure('Existing issue identity and canonical key could not be verified.')
        fields = data['fields']
        if (not isinstance(fields.get('summary'), str) or
                any(not isinstance(fields.get(k), dict) or not numeric_id(fields[k].get('id'))
                    for k in ('project', 'issuetype', 'status'))):
            raise Failure('Existing issue project, type, status and summary could not be verified.')
        return data

    def details(self, data):
        fields = data['fields']
        links = fields.get('issuelinks')
        if not isinstance(links, list):
            raise Failure('Existing issue links could not be verified.')
        safe_links = []
        for link in links:
            if not isinstance(link, dict) or not isinstance(link.get('type'), dict):
                raise Failure('Existing issue link details are malformed.')
            sides = [side for side in ('inward', 'outward') if side + 'Issue' in link]
            if len(sides) != 1 or not isinstance(link[sides[0] + 'Issue'], dict):
                raise Failure('Existing issue link orientation is malformed.')
            target = link[sides[0] + 'Issue']
            safe_links.append({'type': selected_details(link['type'], ('id', 'name', 'inward', 'outward')),
                               'direction': sides[0], 'issue': selected_details(target, ('id', 'key')),
                               'summary': target.get('fields', {}).get('summary')})
        return {'id': data['id'], 'key': data['key'], 'link': self.browser_url + '/browse/' + data['key'],
                'details': {'summary': fields['summary'], 'description': fields.get('description'),
                            'project': selected_details(fields['project'], ('id', 'key', 'name')),
                            'type': selected_details(fields['issuetype'], ('id', 'name', 'subtask', 'hierarchyLevel')),
                            'status': selected_details(fields['status'], ('id', 'name')),
                            'assignee': selected_details(fields.get('assignee'), ('accountId', 'displayName', 'active')),
                            'reporter': selected_details(fields.get('reporter'), ('accountId', 'displayName', 'active')),
                            'parent': selected_details(fields.get('parent'), ('id', 'key')),
                            'story_points': fields.get('customfield_10004'), 'links': safe_links}}

    def get(self, reference):
        return self.details(self.read_issue(reference))

    def identity(self, value, myself):
        # Existing tickets have no authenticated-user identity defaults. Resolve
        # only explicit changes and require affirmative active-user metadata.
        if value.startswith('id:'):
            account = value[3:]
            user = self.request('GET', 'user', params={'accountId': account})
            if not account or user.get('accountId') != account or user.get('active') is not True:
                raise Failure('Account ID must identify a verified active user.')
            return account
        users = self.request('GET', 'user/search', params={'query': value, 'maxResults': 1000})
        if not isinstance(users, list) or len(users) >= 1000:
            raise Failure('User search is incomplete; use id:ACCOUNT_ID.')
        matches = {u['accountId'] for u in users if isinstance(u, dict) and u.get('active') is True
                   and isinstance(u.get('accountId'), str) and u['accountId'] and
                   value.casefold() in (u.get('displayName', '').casefold(), u.get('emailAddress', '').casefold())}
        if len(matches) != 1:
            raise Failure('Name/email must resolve to exactly one verified active user; use id:ACCOUNT_ID.')
        return matches.pop()

    @staticmethod
    def check_edit_field(metadata, name, value):
        field = metadata.get(name)
        if (not isinstance(field, dict) or field.get('schema', {}).get('type') != FIELD_SCHEMA[name]
                or 'set' not in field.get('operations', [])):
            raise Failure(f'Requested field {name} cannot be set on this edit screen; unsupported moves require a separately approved Jira UI workflow.')
        if 'allowedValues' in field:
            allowed = field['allowedValues']
            if not isinstance(allowed, list):
                raise Failure(f'Requested field {name} has malformed allowed values.')
            identifier = value.get('id', value.get('accountId')) if isinstance(value, dict) else value
            def allowed_id(item):
                return item.get('id', item.get('accountId', item.get('value'))) if isinstance(item, dict) else item
            if not any(str(allowed_id(item)) == str(identifier) for item in allowed):
                raise Failure(f'Requested field {name} is not an allowed value.')

    def direct_transition(self, issue_id, target):
        data = self.request('GET', f'issue/{issue_id}/transitions', params={'expand': 'transitions.fields'})
        transitions = data.get('transitions') if isinstance(data, dict) else None
        if not isinstance(transitions, list):
            raise Failure('Invalid direct transition metadata.')
        matches = [t for t in transitions if str(t.get('to', {}).get('id')) == target['id']]
        if len(matches) != 1 or not numeric_id(matches[0].get('id')):
            raise Failure('No unique direct transition to requested status; no intermediate transitions attempted.')
        fields = matches[0].get('fields', {})
        if not isinstance(fields, dict) or any(not isinstance(f, dict) or
                (f.get('required') and not f.get('hasDefaultValue')) for f in fields.values()):
            raise Failure('Direct transition requires additional fields; no values were guessed.')
        return {'id': str(matches[0]['id']), 'to': target}

    def prepare_update(self, reference, draft):
        current = self.read_issue(reference, all_fields=True)
        issue_id, old = current['id'], current['fields']
        # Jira GET editmeta returns an unpaginated fields OBJECT, not create pages.
        edit = self.request('GET', f'issue/{issue_id}/editmeta')
        metadata = edit.get('fields') if isinstance(edit, dict) else None
        if not isinstance(metadata, dict):
            raise Failure('Invalid edit metadata; expected an unpaginated fields object.')
        requested, payload = {}, {}
        project_id, type_id = str(old['project']['id']), str(old['issuetype']['id'])
        project = old['project']
        selected_type = old['issuetype']
        groups = None
        if any(k in draft for k in ('project', 'type', 'status', 'parent')) or points_value(str(draft.get('story_points', 'unset'))) is not None:
            project = self.request('GET', 'project/' + draft.get('project', project_id))
            if (not isinstance(project, dict) or not numeric_id(project.get('id')) or
                    not isinstance(project.get('key'), str) or not project['key'] or
                    not all(c.isalnum() or c == '_' for c in project['key'])):
                raise Failure('Resulting project could not be verified.')
            project_id = str(project['id'])
        if any(k in draft for k in ('project', 'type', 'status', 'parent')):
            types = project.get('issueTypes')
            if not isinstance(types, list):
                raise Failure('Live resulting project issue types could not be verified.')
            selected_type = self.unique(types, draft.get('type', type_id), 'Issue type')
            if not numeric_id(selected_type.get('id')):
                raise Failure('Resulting issue type ID could not be verified.')
            type_id = str(selected_type['id'])
            groups = self.request('GET', f'project/{project_id}/statuses')
            groups = [g for g in groups if str(g.get('id')) == type_id]
            if len(groups) != 1:
                raise Failure('No unique status metadata for resulting issue type.')
            # A move/type edit must not implicitly move/reset omitted status.
            if 'status' not in draft and not any(str(s.get('id')) == str(old['status']['id']) for s in groups[0]['statuses']):
                raise Failure('Resulting project/type cannot preserve the omitted current status; no implicit status reset is permitted.')
        if 'sprint' in draft and (project_id != str(old['project']['id']) or type_id != str(old['issuetype']['id'])):
            raise Failure('Sprint updates cannot be combined with an actual project/type move. Complete and verify the move separately, then rediscover and approve the sprint.')
        if 'project' in draft:
            requested['project'] = {'id': project_id}
        if 'type' in draft:
            requested['issuetype'] = {'id': type_id}
        for name in ('summary', 'description'):
            if name in draft:
                requested[name] = draft[name]
        for name in ('assignee', 'reporter'):
            if name in draft:
                previous = (old.get(name) or {}).get('accountId')
                # An explicitly unchanged ID does not require reassignability.
                account = previous if draft[name] == 'id:' + str(previous) else self.identity(draft[name], {})
                requested[name] = {'accountId': account}
                if name == 'assignee' and account != previous:
                    users = self.request('GET', 'user/assignable/search', params={'project': project['key'], 'accountId': account, 'maxResults': 1000})
                    if not isinstance(users, list) or not any(u.get('accountId') == account and u.get('active') is not False for u in users):
                        raise Failure('Assignee is not assignable in the resulting project.')
        parent_changed_context = project_id != str(old['project']['id']) or type_id != str(old['issuetype']['id'])
        parent = draft.get('parent')
        if parent is None and parent_changed_context and old.get('parent'):
            parent = str(old['parent'].get('id', old['parent'].get('key', '')))
        if parent:
            if not issue_reference(parent):
                raise Failure('Current or supplied parent identity could not be verified.')
            parent_issue = self.request('GET', 'issue/' + parent, params={'fields': 'project,issuetype'})
            pf = parent_issue.get('fields', {})
            child = self.request('GET', 'issuetype/' + type_id)
            child_level = child.get('hierarchyLevel')
            if (not isinstance(parent_issue.get('id'), str) or not parent_issue['id'].isdigit() or
                    parent_issue['id'] == issue_id or str(pf.get('project', {}).get('id')) != project_id or
                    type(child_level) is not int or pf.get('issuetype', {}).get('hierarchyLevel') != child_level + 1):
                raise Failure('Parent must be in the resulting project and immediately above the resulting type hierarchy; current parent cannot be removed implicitly.')
            if 'parent' in draft:
                requested['parent'] = {'id': parent_issue['id']}
        elif selected_type.get('subtask') and (parent_changed_context or 'parent' in draft):
            raise Failure('Resulting sub-task requires a verified parent; no parent was invented.')
        estimate = None
        numeric_points = points_value(str(draft.get('story_points', 'unset')))
        if numeric_points is not None:
            catalog = self.request('GET', 'field')
            matches = [f for f in catalog if f.get('name') == 'Story Points Estimates']
            if len(matches) != 1 or matches[0].get('id') != 'customfield_10004' or matches[0].get('schema', {}).get('type') != 'number':
                raise Failure('Exact numeric Story Points Estimates field could not be verified.')
            requested['customfield_10004'] = numeric_points
            field = metadata.get('customfield_10004')
            if field and field.get('schema', {}).get('type') != 'number':
                raise Failure('Estimate edit-field schema must be numeric.')
            if field and 'set' in field.get('operations', []):
                if 'board' in draft and 'sprint' not in draft:
                    raise Failure('--board is only applicable when Agile estimate fallback is needed.')
            else:
                board = self.estimate_board(project['key'], draft.get('board'))
                before = self.request('GET', f'issue/{issue_id}/estimation', agile=True, params={'boardId': board})
                if before.get('fieldId') != 'customfield_10004':
                    raise Failure('Existing issue board estimation field could not be verified; no writes attempted.')
                # Board must agree with the current issue value, not hide conflicts.
                observed = before.get('value')
                if (observed is not None and points_value(str(observed)) != old.get('customfield_10004')) or (observed is None and old.get('customfield_10004') is not None):
                    raise Failure('Agile estimate and issue field disagree; reconcile before updating.')
                estimate = {'board_id': board, 'field_id': 'customfield_10004',
                            'value': format(Decimal(str(draft['story_points'])), 'f'), 'expected_value': numeric_points,
                            'write_needed': old.get('customfield_10004') != numeric_points}
        for name, value in requested.items():
            if name == 'customfield_10004' and estimate:
                continue
            self.check_edit_field(metadata, name, value)
            if not equal_field(name, old.get(name), value):
                payload[name] = value
        for name, field in metadata.items():
            if not isinstance(field, dict):
                raise Failure('Malformed edit field metadata.')
            if payload and field.get('required') and name not in requested and old.get(name) in (None, '', []):
                raise Failure('A required edit field has no existing or supplied value; no values were invented.')
        status, transition = None, None
        if 'status' in draft:
            target = self.unique(groups[0]['statuses'], draft['status'], 'Status')
            if not numeric_id(target.get('id')):
                raise Failure('Requested status ID could not be verified.')
            status = {'id': str(target['id']), 'name': target['name']}
            if status['id'] != str(old['status']['id']):
                transition = self.direct_transition(issue_id, status)
        sprint = sprints.prepare(api=self, issue_id=issue_id, project_id=project_id,
                                 request=sprints.validate_request(value=draft['sprint']), board_id=draft.get('board')) if 'sprint' in draft else None
        links = self.prepare_links(draft['links']) if draft.get('links') else []
        if links:
            if any(link['issue']['id'] == issue_id or link['issue']['key'].casefold() == current['key'].casefold() for link in links):
                raise Failure('Self-links are not permitted; no writes attempted.')
            _, existing = self.read_links(issue_id)
            for link in links:
                link['relationship'] = link['relationship'].replace('NEW ticket', current['key'], 1)
                link['status'] = 'verified' if (link['type']['id'], link['direction'], link['issue']['id'], link['issue']['key']) in existing else 'pending'
        return {'id': issue_id, 'key': current['key'], 'link': self.browser_url + '/browse/' + current['key'],
                'current': self.details(current)['details'], 'requested_fields': requested,
                'payload': {'fields': payload}, 'estimate': estimate, 'requested_status': status,
                'transition': transition, 'links': links,
                **({'sprint': sprint} if sprint else {}),
                'note': 'Omitted fields unchanged. No generic clearing. Execution: inline edit, estimate, direct status transition, optional exact sprint operation, then link additions. All preparation is read-only; update revalidates live metadata on every invocation. Sprint approval binds the exact supplied ID, never a rollover.'}

    def refresh(self, result):
        current = self.read_issue(result['id'])
        result['key'] = current['key']
        result['link'] = self.browser_url + '/browse/' + current['key']
        return current['fields']

    def apply_update_links(self, result):
        # Reuse creation's catalog, target resolution and readback orientation,
        # but issue requests and POST endpoints use IDs across possible key moves.
        for link in result['links']:
            result['failed_step'] = 'link_precheck'
            data, existing = self.read_links(result['id'])
            if data.get('id') != result['id'] or not issue_reference(data.get('key')):
                raise Failure('Existing issue canonical identity could not be verified for links.')
            result['key'] = data['key']
            result['link'] = self.browser_url + '/browse/' + data['key']
            target = self.request('GET', 'issue/' + link['issue']['id'], params={'fields': 'summary,project'})
            if target.get('id') != link['issue']['id'] or not issue_reference(target.get('key')):
                raise Failure('Link target canonical identity could not be refreshed.')
            link['issue']['key'] = target['key']
            link['relationship'] = f'{result["key"]} {link["type"][link["direction"]]} {target["key"]}'
            expected = (link['type']['id'], link['direction'], target['id'], target['key'])
            if expected not in existing:
                body = {'type': {'id': link['type']['id']},
                        'inwardIssue': {'id': result['id'] if link['direction'] == 'outward' else target['id']},
                        'outwardIssue': {'id': target['id'] if link['direction'] == 'outward' else result['id']}}
                result['failed_step'] = 'link_update'
                link['status'] = 'unverified'
                result['uncertain_operation'] = 'link_update'
                result['writes'] += 1
                self.request('POST', 'issueLink', json=body)
                result['failed_step'] = 'link_verification'
                _, observed = self.read_links(result['id'])
                if expected not in observed:
                    raise Failure('Requested link failed exact type, direction and canonical target readback verification.')
                result.pop('uncertain_operation', None)
            link['status'] = 'verified'

    def update(self, prepared):
        result = {k: prepared[k] for k in ('id', 'key', 'link')}
        result.update(outcome='partial_failure', writes=0, links=[dict(link) for link in prepared['links']])
        fields = prepared['payload']['fields']
        estimate = prepared['estimate']
        target = prepared['requested_status']
        sprint = prepared.get('sprint')
        if sprint:
            result['sprint'] = {**sprint, 'status': 'pending'}
        try:
            if fields:
                result['failed_step'] = 'field_update'
                result['uncertain_operation'] = 'field_update'
                result['writes'] += 1
                self.request('PUT', 'issue/' + result['id'], json={'fields': fields})
                result['failed_step'] = 'field_verification'
                actual = self.refresh(result)
                for name, value in fields.items():
                    if not equal_field(name, actual.get(name), value):
                        raise Failure(f'Requested field {name} failed verification.')
                result.pop('uncertain_operation', None)
            if estimate and estimate['write_needed']:
                path, params = f'issue/{result["id"]}/estimation', {'boardId': estimate['board_id']}
                result['failed_step'] = 'estimate_update'
                result['uncertain_operation'] = 'estimate_update'
                result['writes'] += 1
                self.request('PUT', path, agile=True, params=params, json={'value': estimate['value']})
                result['failed_step'] = 'estimate_verification'
                after = self.request('GET', path, agile=True, params=params)
                if after.get('fieldId') != estimate['field_id'] or points_value(str(after.get('value'))) != estimate['expected_value']:
                    raise Failure('Agile estimate failed readback verification.')
                actual = self.refresh(result)
                if actual.get(estimate['field_id']) != estimate['expected_value']:
                    raise Failure('Agile estimate issue-field readback failed verification.')
                result.pop('uncertain_operation', None)
            if prepared['transition']:
                result['failed_step'] = 'transition_recheck'
                actual = self.refresh(result)
                if str(actual['status']['id']) != target['id']:
                    transition = self.direct_transition(result['id'], target)
                    if transition['id'] != prepared['transition']['id']:
                        raise Failure('Direct transition changed after preflight; no substituted transition attempted.')
                    result['failed_step'] = 'status_transition'
                    result['uncertain_operation'] = 'status_transition'
                    result['writes'] += 1
                    self.request('POST', f'issue/{result["id"]}/transitions', json={'transition': {'id': transition['id']}})
                    result['failed_step'] = 'status_verification'
                    actual = self.refresh(result)
                    if str(actual['status']['id']) != target['id']:
                        raise Failure('Requested status failed verification.')
                    result.pop('uncertain_operation', None)
            if sprint:
                result['failed_step'] = 'sprint_precheck'
                current = self.read_issue(result['id'])
                if (str(current['fields']['project']['id']) != str(prepared['current']['project']['id']) or
                        str(current['fields']['issuetype']['id']) != str(prepared['current']['type']['id'])):
                    raise Failure('Issue project/type changed after sprint preparation; stop and rediscover.')
                sprints.precheck(api=self, issue_id=result['id'], project_id=str(current['fields']['project']['id']), plan=sprint)
                if sprint['write_needed']:
                    result['failed_step'] = 'sprint_update'
                    result['sprint']['status'] = 'unverified'
                    result['uncertain_operation'] = 'sprint_update'
                    result['writes'] += 1
                    self.request('POST', sprint['path'], agile=True, json=sprint['body'])
                result['failed_step'] = 'sprint_verification'
                result['sprint']['status'] = 'unverified'
                sprints.verify(api=self, issue_id=result['id'], plan=sprint)
                result['sprint']['status'] = 'verified'
                result.pop('uncertain_operation', None)
            result['failed_step'] = 'final_verification'
            actual = self.refresh(result)
            for name, value in prepared['requested_fields'].items():
                if not equal_field(name, actual.get(name), value):
                    raise Failure(f'Requested field {name} failed verification.')
            if target and str(actual['status']['id']) != target['id']:
                raise Failure('Requested status failed verification.')
            if sprint:
                result['failed_step'] = 'sprint_verification'
                result['sprint']['status'] = 'unverified'
                if sprint['write_needed']:
                    result['uncertain_operation'] = 'sprint_update'
                sprints.verify(api=self, issue_id=result['id'], plan=sprint)
                result['sprint']['status'] = 'verified'
                result.pop('uncertain_operation', None)
            if result['links']:
                self.apply_update_links(result)
            result['outcome'] = 'updated' if result['writes'] else 'unchanged'
            result.pop('failed_step', None)
            result['verified_fields'] = list(prepared['requested_fields']) + (['status'] if target else []) + (['sprint'] if sprint else [])
        except Failure as exc:
            result['message'] = str(exc)
        except Exception:
            result['message'] = 'Request or verification failed. The current operation may have succeeded; do not repeat uncertain writes.'
        if result['outcome'] == 'partial_failure':
            if result.get('uncertain_operation'):
                result['message'] += ' Mutation attempted but not verified; it may have succeeded. Do not repeat uncertain writes.'
            # A timed-out move may already have changed the key. Reconcile the
            # browser context read-only when possible; never resume mutations.
            try:
                self.refresh(result)
            except Exception:
                pass
            for link in result['links']:
                link['relationship'] = f'{result["key"]} {link["type"][link["direction"]]} {link["issue"]["key"]}'
            actions = [f'{name}={value}' for name, value in prepared['requested_fields'].items()]
            if target:
                actions.append('status=' + target['name'])
            if sprint:
                actions.append('sprint=' + sprint['action'] + ' exact ID ' + sprint['id'] + ' [' + result['sprint']['status'] + ']')
            actions.extend(link['relationship'] + ' [' + link['status'] + ']' for link in result['links'])
            result['remaining_action'] = ('Open the linked existing ticket; reconcile failed step ' + result['failed_step'] +
                                          ' before any further mutation. Verify requested changes: ' + '; '.join(actions) +
                                          '. Manually complete only missing approved changes after review; do not repeat uncertain writes or create a duplicate.')
        return result

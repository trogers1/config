"""Small, fail-closed Jira Cloud creation workflow. No mutation retries."""
import os
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path

import httpx


class Failure(Exception):
    """Only locally authored, credential-free messages belong here."""


def configuration(path=None):
    from jiratui.config import ApplicationConfiguration
    previous = os.environ.get('JIRA_TUI_CONFIG_FILE')
    try:
        if path:
            os.environ['JIRA_TUI_CONFIG_FILE'] = str(Path(path).expanduser().resolve())
        return ApplicationConfiguration()
    finally:
        if path:
            if previous is None:
                os.environ.pop('JIRA_TUI_CONFIG_FILE', None)
            else:
                os.environ['JIRA_TUI_CONFIG_FILE'] = previous


def client_for(config):
    if not config.cloud or config.use_bearer_authentication or config.use_cert_authentication:
        raise Failure('Only Jira Cloud Basic authentication is supported.')
    ssl = config.ssl
    if ssl is None:
        from jiratui.config import SSLConfiguration
        ssl = SSLConfiguration()
    if not ssl.verify_ssl or ssl.certificate_file or ssl.key_file:
        raise Failure('Verified TLS without client certificates is required.')
    url = httpx.URL(config.jira_api_base_url)
    if url.scheme != 'https' or url.username or url.password or url.query or url.fragment:
        raise Failure('A credential-free HTTPS API base URL is required.')
    if not config.jira_api_username or not config.jira_api_token.get_secret_value():
        raise Failure('Configured API username and token are required.')
    return httpx.Client(base_url=str(url).rstrip('/') + '/',
                        auth=(config.jira_api_username, config.jira_api_token.get_secret_value()),
                        verify=ssl.ca_bundle or True, timeout=30, follow_redirects=False)


def text_adf(text):
    # Literal text: no Markdown parsing or whitespace stripping. Each line is a
    # paragraph (including empty lines); markup stays visible and intact.
    return {'type': 'doc', 'version': 1, 'content': [
        {'type': 'paragraph', 'content': [{'type': 'text', 'text': line}]} if line
        else {'type': 'paragraph', 'content': []}
        for line in text.split('\n')]}


def validate_adf(doc):
    if not isinstance(doc, dict) or doc.get('type') != 'doc' or type(doc.get('version')) is not int or doc.get('version') != 1:
        raise Failure('Description must be an ADF doc with version 1.')
    # Deliberately narrow supported ADF subset, rather than accepting malformed
    # arbitrary JSON. Unsupported nodes/attributes are rejected, never dropped.
    containers = {'doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock'}
    children = {'doc': containers - {'doc', 'listItem'}, 'paragraph': {'text', 'hardBreak'},
                'heading': {'text', 'hardBreak'}, 'bulletList': {'listItem'},
                'orderedList': {'listItem'}, 'listItem': containers - {'doc', 'listItem'},
                'blockquote': containers - {'doc', 'listItem'}, 'codeBlock': {'text'}}
    attrs = {'heading': {'level'}, 'orderedList': {'order'}, 'codeBlock': {'language'}}
    def visit(node):
        if not isinstance(node, dict):
            raise Failure('Invalid ADF node.')
        kind = node.get('type')
        if kind not in containers | {'text', 'hardBreak'}:
            raise Failure('Unsupported ADF node; use the documented subset or literal text.')
        allowed = {'type', 'content', 'attrs'} if kind in containers else {'type'}
        if kind == 'doc':
            allowed.add('version')
        if kind == 'text':
            allowed |= {'text', 'marks'}
            if not isinstance(node.get('text'), str) or not node['text']:
                raise Failure('ADF text nodes require nonempty text.')
            if not isinstance(node.get('marks', []), list):
                raise Failure('ADF marks require an array.')
            for mark in node.get('marks', []):
                if mark not in ({'type': 'strong'}, {'type': 'em'}, {'type': 'code'}, {'type': 'strike'}):
                    raise Failure('Unsupported ADF mark.')
        if not isinstance(node.get('attrs', {}), dict):
            raise Failure('ADF attributes require an object.')
        if set(node) - allowed or set(node.get('attrs', {})) - attrs.get(kind, set()):
            raise Failure('Unsupported ADF attributes.')
        attributes = node.get('attrs', {})
        if kind == 'heading' and (type(attributes.get('level')) is not int or attributes['level'] not in range(1, 7)):
            raise Failure('ADF heading level must be 1 through 6.')
        if kind == 'orderedList' and 'order' in attributes and (type(attributes['order']) is not int or attributes['order'] < 1):
            raise Failure('ADF list order must be a positive integer.')
        if kind == 'codeBlock' and 'language' in attributes and not isinstance(attributes['language'], str):
            raise Failure('ADF code language must be a string.')
        if kind in containers:
            if not isinstance(node.get('content'), list):
                raise Failure('ADF containers require content arrays.')
            for child in node['content']:
                if not isinstance(child, dict) or child.get('type') not in children[kind]:
                    raise Failure('Invalid ADF child node.')
                visit(child)
    visit(doc)
    def has_text(node):
        return (node.get('type') == 'text' and bool(node['text'].strip())) or any(has_text(child) for child in node.get('content', []))
    if not has_text(doc):
        raise Failure('Description must not be empty.')
    return doc


def points_value(value):
    if value == 'unset':
        return None
    try:
        number = Decimal(value)
        if not number.is_finite() or number < 0:
            raise ValueError
        result = float(number)
        if result == float('inf') or (number != 0 and result == 0):
            raise ValueError
        return result
    except (InvalidOperation, ValueError, TypeError):
        raise Failure('Story points must be a finite nonnegative number or unset.') from None


def issue_reference(value):
    """Only existing Jira keys/IDs, never draft names or batch placeholders."""
    return isinstance(value, str) and re.fullmatch(r'(?:[0-9]+|[A-Za-z][A-Za-z0-9_]*-[0-9]+)', value) is not None


def validate_links(links):
    if not isinstance(links, list):
        raise Failure('links must be an array; omit it or use [] when no links are approved.')
    for link in links:
        if not isinstance(link, dict) or set(link) != {'type', 'direction', 'issue'}:
            raise Failure('Each links entry must contain exactly type, direction and issue; remove unknown keys and add missing keys.')
        if not all(isinstance(link[k], str) and link[k].strip() for k in link):
            raise Failure('Each links entry requires nonempty strings for type, direction and issue.')
        if link['direction'] not in ('inward', 'outward'):
            raise Failure('Link direction must be exactly inward or outward, from the new ticket perspective; verify labels with jira-ticket link-types.')
        if not issue_reference(link['issue']):
            raise Failure('Link issue must be an existing Jira key or numeric ID, not a synthetic or batch reference.')
    return links


def metadata_id(*, value: object) -> str:
    if (not isinstance(value, (str, int)) or isinstance(value, bool) or
            not str(value).isascii() or not str(value).isdigit()):
        raise Failure('Sprint/board metadata requires numeric IDs.')
    return str(value)


class Creator:
    def __init__(self, client, browser_url=None):
        self.client = client
        url = httpx.URL(browser_url or str(client.base_url))
        if url.scheme != 'https' or url.username or url.password or url.query or url.fragment:
            raise Failure('A credential-free HTTPS browser URL is required.')
        self.browser_url = str(url).rstrip('/')

    def request(self, method, path, *, agile=False, **kwargs):
        prefix = 'rest/agile/1.0/' if agile else 'rest/api/3/'
        response = self.client.request(method, prefix + path, **kwargs)
        if not 200 <= response.status_code < 300:
            raise Failure(f'{method} {path.split("?")[0]} failed: HTTP {response.status_code}.')
        return response.json() if response.content else {}

    def pages(self, path, key, *, params=None, agile=False, strict=False):
        results, start = [], 0
        seen, expected_total = set(), None
        while True:
            data = self.request('GET', path, agile=agile,
                                params={**(params or {}), 'startAt': start, 'maxResults': 100})
            if not isinstance(data, dict):
                raise Failure('Unexpected metadata page shape.')
            page = data.get(key)
            if not isinstance(page, list):
                raise Failure('Unexpected metadata page shape.')
            if strict:
                if ('startAt' in data and (type(data['startAt']) is not int or data['startAt'] != start)
                        or 'isLast' in data and type(data['isLast']) is not bool
                        or 'total' in data and (type(data['total']) is not int or data['total'] < 0)
                        or 'maxResults' in data and (type(data['maxResults']) is not int or data['maxResults'] < 1 or len(page) > data['maxResults'])
                        or expected_total is not None and 'total' not in data):
                    raise Failure('Malformed sprint metadata pagination.')
                if 'total' in data:
                    if expected_total is not None and expected_total != data['total']:
                        raise Failure('Sprint metadata pagination total changed.')
                    expected_total = data['total']
                    end = start + len(page)
                    if end > expected_total or ('isLast' in data and data['isLast'] != (end == expected_total)):
                        raise Failure('Contradictory sprint metadata pagination.')
                for item in page:
                    identity = metadata_id(value=item.get('id') if isinstance(item, dict) else None)
                    if identity in seen:
                        raise Failure('Repeated sprint metadata ID; pagination cannot be trusted.')
                    seen.add(identity)
            results.extend(page)
            start += len(page)
            if data.get('isLast') is True or ('total' in data and start >= data['total']):
                return results
            if not page or ('total' not in data and 'isLast' not in data):
                raise Failure('Incomplete metadata pagination.')

    @staticmethod
    def unique(items, selector, label):
        matches = [item for item in items if str(item.get('id')) == selector or item.get('name', '').casefold() == selector.casefold()]
        if len(matches) != 1:
            raise Failure(f'{label} must resolve to exactly one verified value.')
        return matches[0]

    def identity(self, value, myself):
        if value is None:
            return myself['accountId']
        if value.startswith('id:'):
            user = self.request('GET', 'user', params={'accountId': value[3:]})
            if user.get('accountId') != value[3:] or user.get('active') is False:
                raise Failure('Account ID must identify an active user.')
            return user['accountId']
        users = self.request('GET', 'user/search', params={'query': value, 'maxResults': 1000})
        if len(users) >= 1000:
            raise Failure('User search may be truncated; use id:ACCOUNT_ID.')
        matches = {u['accountId'] for u in users if u.get('active') is not False and
                   value.casefold() in (u.get('displayName', '').casefold(), u.get('emailAddress', '').casefold())}
        if len(matches) != 1:
            raise Failure('Name/email must resolve to exactly one active user; use id:ACCOUNT_ID.')
        return matches.pop()

    def estimate_board(self, project, override=None):
        boards = self.pages('board', 'values', agile=True, params={'projectKeyOrId': project})
        if override is not None:
            if not str(override).isdigit():
                raise Failure('Board ID must be numeric.')
            boards = [b for b in boards if str(b['id']) == str(override)]
            if len(boards) != 1:
                raise Failure('Board override must identify one board returned for this project.')
        eligible = []
        for board in boards:
            if not str(board.get('id', '')).isdigit():
                raise Failure('Unexpected board metadata ID.')
            config = self.request('GET', f'board/{board["id"]}/configuration', agile=True)
            estimation = config.get('estimation', {})
            field = estimation.get('field', {})
            if (estimation.get('type') == 'field' and field.get('fieldId') == 'customfield_10004'
                    and field.get('displayName') == 'Story Points Estimates'):
                eligible.append(board)
        if len(eligible) != 1:
            raise Failure('Agile estimate requires exactly one eligible project board; use --board to resolve ambiguity. Its estimator must be Story Points Estimates (customfield_10004).')
        return str(eligible[0]['id'])

    def link_types(self):
        # This endpoint is not paginated. Never treat a malformed catalog as empty.
        data = self.request('GET', 'issueLinkType')
        items = data.get('issueLinkTypes') if isinstance(data, dict) else None
        if not isinstance(items, list):
            raise Failure('Invalid issue link type catalog; expected issueLinkTypes array.')
        catalog, ids = [], set()
        for item in items:
            if (not isinstance(item, dict) or
                    not all(isinstance(item.get(k), str) and item[k].strip()
                            for k in ('id', 'name', 'inward', 'outward')) or
                    not item['id'].isascii() or not item['id'].isdigit() or item['id'] in ids):
                raise Failure('Invalid or duplicate issue link type metadata; id, name, inward and outward must be verified nonempty strings.')
            ids.add(item['id'])
            catalog.append({k: item[k] for k in ('id', 'name', 'inward', 'outward')})
        return catalog

    def prepare_links(self, links):
        catalog = self.link_types()
        plans, seen = [], set()
        for link in links:
            selected = self.unique(catalog, link['type'], 'Link type (use jira-ticket link-types)')
            issue = self.request('GET', 'issue/' + link['issue'], params={'fields': 'summary,project'})
            fields = issue.get('fields') if isinstance(issue, dict) else None
            if (not isinstance(issue, dict) or not isinstance(fields, dict) or
                    not isinstance(issue.get('id'), str) or not issue['id'].isascii() or not issue['id'].isdigit() or
                    not issue_reference(issue.get('key')) or '-' not in issue['key'] or
                    not isinstance(fields.get('summary'), str) or not fields['summary'].strip() or
                    not isinstance(fields.get('project'), dict) or not fields['project'].get('id')):
                raise Failure('Existing link target identity, key, summary and project could not be verified; no writes attempted.')
            canonical = (selected['id'], link['direction'], issue['id'])
            if canonical in seen:
                raise Failure('Duplicate canonical link requested; keep only one entry for each type, direction and existing issue.')
            seen.add(canonical)
            plans.append({'type': selected, 'direction': link['direction'],
                          'issue': {'id': issue['id'], 'key': issue['key'], 'summary': fields['summary']},
                          'relationship': f'NEW ticket {selected[link["direction"]]} {issue["key"]}'})
        return plans

    def read_links(self, key):
        data = self.request('GET', 'issue/' + key, params={'fields': 'issuelinks'})
        fields = data.get('fields') if isinstance(data, dict) else None
        links = fields.get('issuelinks') if isinstance(fields, dict) else None
        if not isinstance(links, list):
            raise Failure('Missing or malformed issuelinks readback; cannot safely infer no existing links.')
        canonical = set()
        for link in links:
            if not isinstance(link, dict) or not isinstance(link.get('type'), dict):
                raise Failure('Malformed issuelinks readback; cannot safely verify relationships.')
            type_id = link['type'].get('id')
            sides = [side for side in ('inward', 'outward') if side + 'Issue' in link]
            if (not isinstance(type_id, str) or not type_id.isascii() or not type_id.isdigit() or len(sides) != 1):
                raise Failure('Malformed issuelinks type or direction readback.')
            direction = sides[0]
            target = link[direction + 'Issue']
            if (not isinstance(target, dict) or not isinstance(target.get('id'), str) or
                    not target['id'].isascii() or not target['id'].isdigit() or
                    not issue_reference(target.get('key')) or '-' not in target['key']):
                raise Failure('Malformed issuelinks target identity readback.')
            # On GET, outwardIssue means this ticket has the outward label.
            canonical.add((type_id, direction, target['id'], target['key']))
        return data, canonical

    def apply_links(self, result, created_id):
        key = result['key']
        for link in result['links']:
            result['failed_step'] = 'link_precheck'
            data, existing = self.read_links(key)
            new_id = created_id or data.get('id')
            if not isinstance(new_id, str) or not new_id.isascii() or not new_id.isdigit():
                raise Failure('Created issue ID could not be verified for self-link safety; no link write attempted.')
            target = link['issue']
            if any(item['issue']['id'] == new_id or item['issue']['key'].casefold() == key.casefold()
                   for item in result['links']):
                raise Failure('Self-links are not permitted; no link write attempted.')
            expected = (link['type']['id'], link['direction'], target['id'], target['key'])
            if expected not in existing:
                # Jira POST orientation is the opposite endpoint naming to GET.
                body = {'type': {'id': link['type']['id']},
                        'inwardIssue': {'key': key if link['direction'] == 'outward' else target['key']},
                        'outwardIssue': {'key': target['key'] if link['direction'] == 'outward' else key}}
                result['failed_step'] = 'link_update'
                link['status'] = 'unverified'
                self.request('POST', 'issueLink', json=body)
                result['failed_step'] = 'link_verification'
                _, observed = self.read_links(key)
                if expected not in observed:
                    raise Failure('Requested link failed exact type, direction and canonical target readback verification; write may have succeeded. Do not repeat uncertain link writes.')
            link['status'] = 'verified'

    def prepare(self, *, project, summary, description, issue_type, status, points,
                assignee=None, reporter=None, parent=None, board=None, links=None):
        links = validate_links([] if links is None else links)
        if not all(isinstance(v, str) and v.strip() for v in (project, summary, issue_type, status)):
            raise Failure('Project, summary, type and status are required.')
        if not all(c.isalnum() or c in '-_' for c in project):
            raise Failure('Invalid project key/ID.')
        if len(summary) > 255:
            raise Failure('Summary exceeds 255 characters.')
        description = validate_adf(description)
        estimate = points_value(points)
        project_data = self.request('GET', 'project/' + project)
        project_id = str(project_data['id'])
        types = self.pages(f'issue/createmeta/{project_id}/issuetypes', 'issueTypes')
        selected = self.unique(types, issue_type, 'Issue type')
        type_id = str(selected['id'])
        status_groups = self.request('GET', f'project/{project_id}/statuses')
        groups = [g for g in status_groups if str(g['id']) == type_id]
        if len(groups) != 1:
            raise Failure('No unique status metadata for issue type.')
        target = self.unique(groups[0]['statuses'], status, 'Status')
        metadata = self.pages(f'issue/createmeta/{project_id}/issuetypes/{type_id}', 'fields')
        fields = {}
        for field in metadata:
            key = field.get('fieldId', field.get('key'))
            if not key or key in fields:
                raise Failure('Ambiguous create field metadata.')
            fields[key] = field
        myself = self.request('GET', 'myself')
        if not myself.get('accountId') or myself.get('active') is False:
            raise Failure('Authenticated account is not active.')
        assigned = self.identity(assignee, myself)
        reported = self.identity(reporter, myself)
        assignable = self.request('GET', 'user/assignable/search', params={'project': project_data['key'], 'accountId': assigned, 'maxResults': 1000})
        if not any(u.get('accountId') == assigned for u in assignable):
            raise Failure('Assignee is not assignable in this project.')
        payload = {'project': {'id': project_id}, 'issuetype': {'id': type_id},
                   'summary': summary, 'description': description,
                   'assignee': {'accountId': assigned}, 'reporter': {'accountId': reported}}
        if parent:
            if not all(c.isalnum() or c == '-' for c in parent):
                raise Failure('Invalid parent key/ID.')
            parent_issue = self.request('GET', 'issue/' + parent, params={'fields': 'project,issuetype'})
            pf = parent_issue['fields']
            child_info = self.request('GET', 'issuetype/' + type_id)
            child_level = child_info.get('hierarchyLevel')
            parent_level = pf['issuetype'].get('hierarchyLevel')
            if str(pf['project']['id']) != project_id or child_level is None or parent_level != child_level + 1:
                raise Failure('Parent must be in the same project and immediately above the selected type hierarchy.')
            payload['parent'] = {'id': str(parent_issue['id'])}
        elif selected.get('subtask'):
            raise Failure('Sub-task requires an explicit parent.')
        estimate_plan = None
        if estimate is None and board is not None:
            raise Failure('--board requires numeric story points.')
        if estimate is not None:
            catalog = self.request('GET', 'field')
            matches = [f for f in catalog if f.get('name') == 'Story Points Estimates']
            if len(matches) != 1 or matches[0].get('id') != 'customfield_10004' or matches[0].get('schema', {}).get('type') != 'number':
                raise Failure('Exact numeric Story Points Estimates field could not be verified.')
            estimate_field = fields.get('customfield_10004')
            if estimate_field and estimate_field.get('schema', {}).get('type') != 'number':
                raise Failure('Estimate create-field schema must be numeric.')
            writable = estimate_field and ('operations' not in estimate_field or 'set' in estimate_field['operations'])
            if writable:
                if board is not None:
                    raise Failure('--board is only applicable when Agile estimate fallback is needed.')
                payload['customfield_10004'] = estimate
            else:
                estimate_plan = {'board_id': self.estimate_board(project_data['key'], board),
                                 'field_id': 'customfield_10004', 'value': format(Decimal(points), 'f'),
                                 'expected_value': estimate}
        expected_schema = {'project': 'project', 'issuetype': 'issuetype', 'summary': 'string',
                           'description': 'string', 'assignee': 'user', 'reporter': 'user',
                           'parent': 'issuelink', 'customfield_10004': 'number'}
        for key, value in payload.items():
            field = fields.get(key)
            # Jira may advertise no set operation for issuetype: it is the
            # creation selector already verified against the project's types,
            # not an editable field. All other fields retain writable checks.
            writable = key == 'issuetype' or 'operations' not in (field or {}) or 'set' in field['operations']
            if not field or field.get('schema', {}).get('type') != expected_schema[key] or not writable:
                raise Failure(f'Requested field {key} cannot be set on this create screen.')
            allowed = field.get('allowedValues')
            if allowed:
                identifier = value.get('id', value.get('accountId')) if isinstance(value, dict) else value
                if not any(str(v.get('id', v.get('accountId', v.get('value')))) == str(identifier) for v in allowed):
                    raise Failure(f'Requested field {key} is not an allowed value.')
        for key, field in fields.items():
            if field.get('required') and key not in payload and not field.get('hasDefaultValue'):
                raise Failure(f'Required field {key} has no supplied value or verified default.')
        prepared = {'payload': {'fields': payload}, 'requested_status': {'id': str(target['id']), 'name': target['name']}}
        if estimate_plan:
            prepared['post_create_estimate'] = estimate_plan
        if links:
            prepared['post_create_links'] = self.prepare_links(links)
        return prepared

    def create(self, prepared):
        # Once POST begins, any exception is partial/unknown success. Never retry.
        result = {'outcome': 'unknown', 'message': 'Creation outcome unknown; no key is available, so no browser link can be supplied. Reconcile with Jira before any further mutation.'}
        try:
            created = self.request('POST', 'issue', json=prepared['payload'])
            key = created.get('key')
            if not isinstance(key, str) or not key or not all(c.isalnum() or c == '-' for c in key):
                return result
            result = {'outcome': 'partial_failure', 'key': key, 'link': self.browser_url + '/browse/' + key}
            if prepared.get('post_create_links'):
                result['links'] = [{**link, 'status': 'pending'} for link in prepared['post_create_links']]
            fields = dict(prepared['payload']['fields'])
            plan = prepared.get('post_create_estimate')
            if plan:
                result['failed_step'] = 'estimate_precheck'
                path = 'issue/' + key + '/estimation'
                params = {'boardId': plan['board_id']}
                before = self.request('GET', path, agile=True, params=params)
                if before.get('fieldId') != plan['field_id']:
                    raise Failure('Created issue board estimation field could not be verified; no estimate write attempted.')
                result['failed_step'] = 'estimate_update'
                self.request('PUT', path, agile=True, params=params, json={'value': plan['value']})
                result['failed_step'] = 'estimate_verification'
                after = self.request('GET', path, agile=True, params=params)
                if (after.get('fieldId') != plan['field_id'] or
                        points_value(str(after.get('value'))) != plan['expected_value']):
                    raise Failure('Agile estimate failed readback verification.')
                fields[plan['field_id']] = plan['expected_value']
            target = prepared['requested_status']['id']
            def readback():
                return self.request('GET', 'issue/' + key, params={'fields': ','.join(fields) + ',status'})['fields']
            result['failed_step'] = 'issue_verification'
            actual = readback()
            if str(actual['status']['id']) != target:
                result['failed_step'] = 'transition_discovery'
                transitions = self.request('GET', 'issue/' + key + '/transitions', params={'expand': 'transitions.fields'})['transitions']
                matches = [t for t in transitions if str(t.get('to', {}).get('id')) == target]
                if len(matches) != 1:
                    raise Failure('No unique direct transition to requested status; no intermediate transitions attempted.')
                if any(f.get('required') and not f.get('hasDefaultValue') for f in matches[0].get('fields', {}).values()):
                    raise Failure('Direct transition requires additional fields; no values were guessed.')
                result['failed_step'] = 'status_transition'
                self.request('POST', 'issue/' + key + '/transitions', json={'transition': {'id': str(matches[0]['id'])}})
                result['failed_step'] = 'final_verification'
                actual = readback()
            for name, expected in fields.items():
                observed = actual.get(name)
                if isinstance(expected, dict) and name != 'description':
                    attr = 'accountId' if name in ('assignee', 'reporter') else 'id'
                    equal = isinstance(observed, dict) and str(observed.get(attr)) == str(expected[attr])
                else:
                    equal = observed == expected
                if not equal:
                    raise Failure(f'Created field {name} failed verification.')
            if str(actual['status']['id']) != target:
                raise Failure('Created status failed verification.')
            if result.get('links'):
                self.apply_links(result, created.get('id'))
            result['outcome'] = 'created'
            result.pop('failed_step', None)
        except Failure as exc:
            result['message'] = str(exc)
            if result['outcome'] == 'unknown':
                result['message'] += ' No key established, so no browser link is available; reconcile with Jira before any further mutation.'
        except Exception:
            result['message'] = 'Request or verification failed; creation, estimate update, status transition or link write may have succeeded. Do not retry creation or repeat uncertain writes.'
            if result['outcome'] == 'unknown':
                result['message'] += ' No key is available and no browser link can be supplied; reconciliation is required.'
        if result['outcome'] == 'partial_failure':
            if any(link['status'] == 'unverified' for link in result.get('links', [])):
                result['message'] += ' Link write attempted but unverified; it may have succeeded. Reconcile before any further link writes.'
            estimate = prepared.get('post_create_estimate', {}).get('value', prepared['payload']['fields'].get('customfield_10004'))
            estimate_action = f' and Story Points Estimates={estimate}' if estimate is not None else ''
            result['remaining_action'] = (f'Open the linked ticket and verify approved fields{estimate_action} and status={prepared["requested_status"]["name"]}. '
                                          'Manually repair as needed; do not create a duplicate or repeat uncertain writes.')
            if result.get('links'):
                result['remaining_action'] += ' Approved relationships: ' + '; '.join(
                    f'{link["relationship"].replace("NEW ticket", result["key"], 1)} [{link["status"]}]'
                    for link in result['links']) + '. Reconcile unverified writes in Jira before manually completing pending links; no further link writes were attempted after failure.'
        return result

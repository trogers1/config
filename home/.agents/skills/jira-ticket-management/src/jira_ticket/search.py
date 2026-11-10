"""Read-only Jira Cloud enhanced JQL search with explicit token pagination."""
import re

from .core import Failure, issue_reference, metadata_id


FIELDS = ('summary', 'status', 'issuetype')


def scoped_jql(*, jql, project):
    """Separate a top-level ORDER BY without matching quoted text or functions."""
    tokens = list(re.finditer(r'''"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_]+|[()'"\\]''', jql))
    depth, split = 0, len(jql)
    for index, token in enumerate(tokens):
        word = token.group()
        if word in ("'", '"', '\\'):
            raise Failure('Search JQL contains an unterminated string or an escape outside a quoted string.')
        if word == '(':
            depth += 1
        elif word == ')':
            if depth == 0:
                raise Failure('Search JQL contains unmatched parentheses.')
            depth -= 1
        elif depth == 0 and split == len(jql) and word.lower() == 'order' and index + 1 < len(tokens):
            following = tokens[index + 1]
            if following.group().lower() == 'by' and jql[token.end():following.start()].isspace():
                split = token.start()
    if depth != 0:
        raise Failure('Search JQL contains unmatched parentheses.')
    predicate, ordering = jql[:split].strip(), jql[split:].strip()
    scope = f'project = "{project}"'
    return scope + (f' AND ({predicate})' if predicate else '') + (f' {ordering}' if ordering else '')


def search(*, api, jql, project, limit, next_page_token):
    params = {'jql': scoped_jql(jql=jql, project=project), 'maxResults': limit, 'fields': ','.join(FIELDS)}
    if next_page_token is not None:
        params['nextPageToken'] = next_page_token
    data = api.request('GET', 'search/jql', params=params)
    if not isinstance(data, dict) or not isinstance(data.get('issues'), list) or type(data.get('isLast')) is not bool:
        raise Failure('Malformed Jira search page.')
    token = data.get('nextPageToken')
    if (not data['isLast'] and (not isinstance(token, str) or not token.strip() or token == next_page_token)
            or data['isLast'] and token is not None):
        raise Failure('Inconsistent Jira search pagination.')
    if len(data['issues']) > limit:
        raise Failure('Jira search exceeded the requested page limit.')
    issues, seen = [], set()
    for item in data['issues']:
        if not isinstance(item, dict):
            raise Failure('Malformed Jira search issue.')
        identity = metadata_id(value=item.get('id'))
        key, fields = item.get('key'), item.get('fields')
        if not isinstance(key, str) or not issue_reference(key) or key.isdigit() or not isinstance(fields, dict):
            raise Failure('Malformed Jira search issue identity or fields.')
        if identity in seen:
            raise Failure('Duplicate Jira search issue.')
        seen.add(identity)
        if not isinstance(fields.get('summary'), str):
            raise Failure('Missing Jira search summary.')
        details = {'summary': fields['summary']}
        for field in FIELDS[1:]:
            value = fields.get(field)
            if not isinstance(value, dict) or not isinstance(value.get('name'), str):
                raise Failure('Malformed Jira search status or issue type.')
            details[field] = {'id': metadata_id(value=value.get('id')), 'name': value['name']}
        issues.append({'id': identity, 'key': key, 'link': api.issue_link(key=key), **details})
    return {'outcome': 'search', 'read_only': True, 'project': project, 'issues': issues,
            'is_last': data['isLast'], 'next_page_token': token}

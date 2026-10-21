"""Exact, active-sprint operations using the existing Jira transport only."""
from typing import Literal, TypedDict

from .core import Creator, Failure, metadata_id


SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint'
SprintAction = Literal['add', 'remove']
SprintState = Literal['active', 'future', 'closed']


class SprintRequest(TypedDict):
    action: SprintAction
    id: str


class Sprint(TypedDict):
    id: str
    name: str
    state: SprintState


class Board(TypedDict):
    id: str
    name: str
    active_sprints: list[Sprint]


class SprintPlan(TypedDict):
    action: SprintAction
    id: str
    board: Board
    field_id: str
    memberships: list[Sprint]
    expected_ids: list[str]
    path: str
    body: dict[str, list[str]]
    write_needed: bool
    side_effects: str


def validate_request(*, value: object) -> SprintRequest:
    if not isinstance(value, dict) or set(value) != {'action', 'id'}:
        raise Failure('sprint requires exactly action (add/remove) and id (verified active sprint ID string).')
    action, sprint_id = value['action'], value['id']
    if action not in ('add', 'remove') or not isinstance(sprint_id, str):
        raise Failure('sprint requires action add/remove and a numeric active sprint ID string; discover with jira-ticket sprints TARGET.')
    metadata_id(value=sprint_id)
    return {'action': 'add' if action == 'add' else 'remove', 'id': sprint_id}


def validate_sprint(*, value: object) -> Sprint:
    if not isinstance(value, dict) or not isinstance(value.get('name'), str) or not value['name'].strip():
        raise Failure('Malformed structured Sprint metadata; legacy serialized memberships are not supported.')
    state = value.get('state')
    if state == 'active':
        verified_state: SprintState = 'active'
    elif state == 'future':
        verified_state = 'future'
    elif state == 'closed':
        verified_state = 'closed'
    else:
        raise Failure('Sprint metadata requires a documented active, future or closed state.')
    return {'id': metadata_id(value=value.get('id')), 'name': value['name'], 'state': verified_state}


def discover(*, api: Creator, project_id: str, board_id: str | None = None) -> list[Board]:
    raw = api.pages('board', 'values', agile=True, params={'projectKeyOrId': project_id}, strict=True)
    boards: list[Board] = []
    found = False
    for item in raw:
        if (not isinstance(item, dict) or not isinstance(item.get('name'), str) or not item['name'].strip()
                or item.get('type') not in ('scrum', 'kanban', 'simple')):
            raise Failure('Malformed project board metadata.')
        identity = metadata_id(value=item.get('id'))
        if board_id is not None and identity != board_id:
            continue
        found = True
        if item['type'] != 'scrum':
            if board_id is not None:
                raise Failure('Selected board is not a verified Scrum board.')
            continue
        active = [validate_sprint(value=s) for s in api.pages(
            f'board/{identity}/sprint', 'values', agile=True, params={'state': 'active'}, strict=True)]
        if any(s['state'] != 'active' for s in active):
            raise Failure('Active sprint discovery returned a non-active sprint.')
        boards.append({'id': identity, 'name': item['name'], 'active_sprints': active})
    if board_id is not None and not found:
        raise Failure('Board must uniquely identify a board returned for the existing issue project.')
    return boards


def sprint_field(*, api: Creator) -> str:
    catalog = api.request('GET', 'field')
    if not isinstance(catalog, list) or any(not isinstance(f, dict) for f in catalog):
        raise Failure('Malformed field catalog; Sprint field cannot be verified.')
    matches = [f for f in catalog if isinstance(f.get('schema'), dict) and f['schema'].get('custom') == SPRINT_SCHEMA]
    if len(matches) != 1:
        raise Failure('Exactly one Jira Software Sprint schema field is required.')
    field = matches[0]
    identity = field.get('id')
    if (not isinstance(identity, str) or not identity.startswith('customfield_') or
            not identity.removeprefix('customfield_').isascii() or not identity.removeprefix('customfield_').isdigit()
            or field['schema'].get('type') != 'array' or field['schema'].get('items') != 'json'):
        raise Failure('Sprint field requires the documented Jira Software array/json schema.')
    return identity


def memberships(*, api: Creator, issue_id: str, field_id: str) -> list[Sprint]:
    data = api.request('GET', f'issue/{issue_id}', params={'fields': field_id})
    fields = data.get('fields') if isinstance(data, dict) else None
    if not isinstance(data, dict) or data.get('id') != issue_id or not isinstance(fields, dict) or field_id not in fields:
        raise Failure('Sprint membership readback is missing or has the wrong immutable issue identity.')
    raw = fields[field_id]
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        raise Failure('Sprint memberships must be a structured array or null, never serialized Sprint strings.')
    result: list[Sprint] = []
    seen: set[str] = set()
    for item in raw:
        sprint = validate_sprint(value=item)
        if sprint['id'] in seen:
            raise Failure('Duplicate Sprint membership metadata.')
        seen.add(sprint['id'])
        authoritative = validate_sprint(value=api.request('GET', f'sprint/{sprint["id"]}', agile=True))
        if authoritative['id'] != sprint['id'] or authoritative['state'] != sprint['state']:
            raise Failure('Sprint membership state disagrees with live sprint metadata; rediscover and preview again.')
        result.append(authoritative)
    return result


def prepare(*, api: Creator, issue_id: str, project_id: str, request: SprintRequest,
            board_id: str | None = None) -> SprintPlan:
    boards = discover(api=api, project_id=project_id, board_id=board_id)
    if len(boards) != 1:
        raise Failure('Sprint updates require exactly one eligible Scrum board; use jira-ticket sprints TARGET and supply board to resolve ambiguity.')
    board = boards[0]
    if len([s for s in board['active_sprints'] if s['id'] == request['id']]) != 1:
        raise Failure('Exact approved sprint ID is no longer active on the verified board. Rediscover, preview and obtain approval; no rollover substitution.')
    field = sprint_field(api=api)
    before = memberships(api=api, issue_id=issue_id, field_id=field)
    if any(s['id'] == request['id'] and s['state'] != 'active' for s in before):
        raise Failure('Selected active sprint disagrees with issue membership state; rediscover and preview again.')
    nonclosed = {s['id'] for s in before if s['state'] != 'closed'}
    needed = (request['id'] not in nonclosed) if request['action'] == 'add' else (request['id'] in nonclosed)
    # No-op add does not displace anything; backlog is never called for an absent target.
    if needed and nonclosed - {request['id']}:
        raise Failure('Sprint operation would remove/displace additional active or future assignments. Reconcile those memberships separately with approval; no writes attempted.')
    expected = {s['id'] for s in before}
    if request['action'] == 'add':
        expected.add(request['id'])
    else:
        expected.discard(request['id'])
    return {'action': request['action'], 'id': request['id'], 'board': board, 'field_id': field,
            'memberships': before, 'expected_ids': sorted(expected),
            'path': f'sprint/{request["id"]}/issue' if request['action'] == 'add' else 'backlog',
            'body': {'issues': [issue_id]}, 'write_needed': needed,
            'side_effects': 'Assignment/backlog is issue-wide, not a generic Sprint field edit. No additional active/future assignment may be displaced; closed history must be preserved.'}


def signature(*, values: list[Sprint]) -> set[tuple[str, SprintState]]:
    return {(s['id'], s['state']) for s in values}


def precheck(*, api: Creator, issue_id: str, project_id: str, plan: SprintPlan) -> None:
    live = prepare(api=api, issue_id=issue_id, project_id=project_id,
                   request={'action': plan['action'], 'id': plan['id']}, board_id=plan['board']['id'])
    if live['field_id'] != plan['field_id'] or signature(values=live['memberships']) != signature(values=plan['memberships']):
        raise Failure('Sprint memberships or field changed after preparation; stop and preview again before any sprint write.')


def verify(*, api: Creator, issue_id: str, plan: SprintPlan) -> None:
    active = [validate_sprint(value=s) for s in api.pages(
        f'board/{plan["board"]["id"]}/sprint', 'values', agile=True, params={'state': 'active'}, strict=True)]
    if not any(s['id'] == plan['id'] and s['state'] == 'active' for s in active):
        raise Failure('Exact approved sprint is no longer active; sprint outcome cannot be verified.')
    observed = memberships(api=api, issue_id=issue_id, field_id=plan['field_id'])
    expected = signature(values=plan['memberships'])
    if plan['action'] == 'add':
        expected.add((plan['id'], 'active'))
    else:
        expected.discard((plan['id'], 'active'))
    if signature(values=observed) != expected:
        raise Failure('Sprint readback did not match the exact approved assignment and preserved closed history; reconcile before further writes.')

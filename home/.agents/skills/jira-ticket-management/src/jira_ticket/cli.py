"""Approval-driven Jira Cloud tickets: read, create, or explicitly partially update."""
import argparse
import json
from pathlib import Path
import sys

from . import __version__
from .core import Creator, Failure, client_for, configuration, issue_reference, points_value, text_adf, validate_adf, validate_links
from .updater import Updater
from . import sprints


REQUIRED = {'summary', 'description', 'type', 'status', 'story_points'}
OPTIONAL = {'project', 'assignee', 'reporter', 'parent', 'board', 'links'}


class DraftFailure(Failure):
    """Structured local validation; never includes draft values or arbitrary keys."""
    def __init__(self, code, message, *, fields=(), **details):
        super().__init__(message)
        self.error = {'code': code, 'message': message, 'fields': sorted(fields),
                      'remediation': 'Correct the saved draft using jira-ticket draft-example and rerun preflight; no writes were attempted.',
                      **details}


def invalid(message, *fields):
    return DraftFailure('invalid_value', message, fields=fields,
                        remediation='Correct the named fields in the saved draft and rerun preflight; no writes were attempted.')


def example_draft():
    return {'summary': 'Example only: document a local setup workflow',
            'description': 'Example only; do not create this ticket.\n\nReplace this with the complete user-approved description.',
            'type': 'VERIFIED_TYPE_ID_OR_NAME', 'status': 'VERIFIED_STATUS_ID_OR_NAME',
            'story_points': 'unset', 'links': []}


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DraftFailure('duplicate_keys', 'Duplicate JSON keys are not supported; keep exactly one value per key.')
        result[key] = value
    return result


def _constant(value):
    raise invalid('Use a finite nonnegative JSON number for story_points, or the string unset.', 'story_points')


def load_draft(path, *, update=False):
    """Validate the entire saved draft before reading configuration or Jira."""
    try:
        draft = json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=_object,
                           parse_constant=_constant)
    except (OSError, UnicodeError, ValueError):
        raise DraftFailure('invalid_json', 'Draft must be a readable UTF-8 JSON file.', remediation='Check the draft path, file encoding and JSON syntax locally; never put credentials in the draft.') from None
    if not isinstance(draft, dict):
        raise invalid('Draft must be a JSON object; see jira-ticket draft-example.')
    allowed = REQUIRED | OPTIONAL | ({'sprint'} if update else set())
    if set(draft) - allowed:
        # Do not echo arbitrary keys, which might contain secrets.
        raise DraftFailure('unsupported_keys', 'Draft contains unsupported keys; only documented ticket fields are accepted.',
                           unsupported_key_count=len(set(draft) - allowed),
                           allowed_keys=sorted(allowed),
                           remediation='Remove unsupported keys. Prepared payloads, credentials and extra Jira fields are not accepted. Arbitrary key names are redacted.')
    if update and not draft:
        raise invalid('Supply at least one requested change; see jira-ticket draft-example --update.')
    if not update and REQUIRED - set(draft):
        raise DraftFailure('missing_keys', 'Draft is missing required fields.', fields=REQUIRED - set(draft),
                           remediation='Add the missing fields using jira-ticket draft-example; story_points requires an explicit number or unset.')
    if 'sprint' in draft:
        try:
            draft['sprint'] = sprints.validate_request(value=draft['sprint'])
        except Failure as exc:
            raise invalid(str(exc), 'sprint') from None
    if 'links' in draft:
        try:
            validate_links(draft['links'])
        except Failure as exc:
            raise invalid(str(exc), 'links') from None
    for key in sorted((REQUIRED - {'description', 'story_points'}) | (OPTIONAL - {'links'})):
        if key in draft and (not isinstance(draft[key], str) or not draft[key].strip()):
            raise invalid('This field must be a nonempty string; omit unused optional fields rather than using null.', key)
    if 'summary' in draft and len(draft['summary']) > 255:
        raise invalid('Summary exceeds 255 characters; shorten it without changing approved intent.', 'summary')
    if 'project' in draft and not all(c.isalnum() or c in '-_' for c in draft['project']):
        raise invalid('Project must contain only letters, digits, hyphens or underscores.', 'project')
    if 'parent' in draft and not issue_reference(draft['parent']):
        raise invalid('Parent must be an existing Jira key or numeric ID.', 'parent')
    if 'board' in draft and (not draft['board'].isascii() or not draft['board'].isdigit()):
        raise invalid('Board ID must be a numeric string verified for the selected project.', 'board')
    points = draft.get('story_points', 'unset')
    if points != 'unset' and type(points) not in (int, float):
        raise invalid('story_points must be a JSON nonnegative number or the string unset, not a boolean, null or numeric string.', 'story_points')
    try:
        points_value(str(points))
    except Failure:
        raise invalid('story_points must be finite, nonnegative and representable, or the string unset.', 'story_points') from None
    if points == 'unset' and 'board' in draft and 'sprint' not in draft:
        raise invalid('Omit board when story_points is unset.', 'board', 'story_points')
    if update and 'description' not in draft:
        return draft
    description = draft['description']
    if isinstance(description, str):
        if not description.strip():
            raise invalid('Description must contain the complete approved nonempty text.', 'description')
        # Same newline normalization as reading the old literal-text file.
        description = text_adf(description.replace('\r\n', '\n').replace('\r', '\n'))
    elif not isinstance(description, dict):
        raise invalid('Description must be literal text or a supported ADF object; files and prepared payloads are not accepted.', 'description')
    try:
        description = validate_adf(description)
    except (Failure, TypeError, AttributeError, KeyError):
        raise invalid('Invalid or unsupported ADF description; use the documented ADF subset or literal text. Nothing is discarded.', 'description') from None
    if update:
        return draft | {'description': description}
    return dict(project=draft.get('project'), summary=draft['summary'], description=description,
                issue_type=draft['type'], status=draft['status'], points=str(points),
                **{key: draft.get(key) for key in ('assignee', 'reporter', 'parent', 'board', 'links')})


def parser_for_cli():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='Start: jira-ticket doctor (local only)\n'
               'Discover: jira-ticket types; jira-ticket statuses --type VERIFIED_TYPE; jira-ticket link-types\n'
               'Read existing: jira-ticket get KEY_OR_NUMERIC_ID\n'
               'Partial update: jira-ticket update KEY --draft changes.json --dry-run; then approve and omit --dry-run\n'
               'Draft format (offline): jira-ticket draft-example; jira-ticket draft-example --update\n'
               'Read-only: jira-ticket preflight --draft approved.json (alias: dry-run)\n'
               'Mutating, only after full approval: jira-ticket create --draft approved.json\n'
               'Install: uv tool install /absolute/path/to/skill; uv tool update-shell\n'
               'Config: effective jiratui config (JIRA_TUI_CONFIG_FILE or XDG/HOME); never pass credentials.')
    parser.add_argument('--version', action='version', version=f'jira-ticket {__version__}')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('draft-example', help='Print a safe JSON draft example offline; no configuration or requests',
                        description='Print a JSON example, not an approved ticket. Create requires summary, description (literal string or ADF), type, status, story_points (JSON number or unset). With --update: partial draft, create keys plus sprint {action: add|remove, id: VERIFIED_ACTIVE_SPRINT_ID}, at least one key; discover with sprints TARGET [--board ID]. Sprint approval binds that exact active ID; additional active/future displacement is rejected, closed history preserved. Board may be sprint context without points. Otherwise: omitted fields unchanged, no identity defaults or clearing; unset points and [] links are no-ops. Optional string selectors: project, assignee, reporter, parent, board (only with numeric Agile estimate). Optional links array (or []): each object has exactly type (verified link type ID/unique name), direction (inward/outward from target ticket perspective), issue (existing Jira key/ID). Discover labels with jira-ticket link-types and approve natural-language relationships; no synthetic/batch targets. Never include credentials.',
                        epilog='Example: jira-ticket draft-example > draft.json; replace example values and obtain approval.')
    commands.choices['draft-example'].add_argument('--update', action='store_true', help='Partial update example: omitted fields unchanged; no clearing or defaults')
    sprint_command = commands.add_parser('sprints', help='Read existing issue project Scrum boards and active sprints; no writes',
        description='Discover exact active sprint IDs for update-only sprint: {action: add|remove, id: VERIFIED_ACTIVE_SPRINT_ID}. Select a board explicitly if ambiguous; approval binds the exact sprint ID, never a rollover.',
        epilog='Discover: jira-ticket sprints KEY [--board NUMERIC_ID]. Save sprint and optional board in a partial draft; update KEY --draft FILE --dry-run, approve, then execute the unchanged draft.')
    sprint_command.add_argument('issue', help='Existing Jira key or numeric ID')
    sprint_command.add_argument('--board', help='Verified project Scrum board numeric ID string')
    sprint_command.add_argument('--config', type=Path, help='Select jiratui config; never pass credentials')
    for name in ('get', 'update'):
        sub = commands.add_parser(name, help='Read existing ticket details' if name == 'get' else 'Partially update an existing ticket; explicit mutation unless --dry-run',
                                  description='Read-only existing ticket JSON' if name == 'get' else 'Omitted fields unchanged. No generic clearing or create defaults. Update-only sprint: {"action":"add"|"remove", "id":"VERIFIED_ACTIVE_SPRINT_ID"}; discover with sprints TARGET [--board ID]. Optional board context can be shared with estimates. Exact sprint must remain active; extra active/future membership removal is rejected. Preview and approve before writes.',
                                  epilog=f'Example: jira-ticket {name} RI-123' + (' --draft changes.json --dry-run. Format: jira-ticket draft-example --update' if name == 'update' else ' (or numeric ID). No approval needed for GET.'))
        sub.add_argument('issue', help='Existing Jira key or numeric ID')
        sub.add_argument('--config', type=Path, help='Select jiratui config; never pass credentials')
        if name == 'update':
            sub.add_argument('--draft', required=True, type=Path, help='Approved partial UTF-8 JSON draft; create keys plus update-only sprint, at least one key; omitted fields unchanged. Discover: draft-example --update; sprints TARGET')
            sub.add_argument('--dry-run', action='store_true', help='Read-only full update plan; no mutations')
    for name, help_text in (
        ('doctor', 'Local effective configuration check (no requests by default)'),
        ('types', 'Read live, fully paginated issue types'),
        ('statuses', 'Read live statuses for a verified type'),
        ('link-types', 'Read live link type IDs/names and inward/outward labels (existing targets only)'),
        ('preflight', 'Read-only validation of the complete saved draft'),
        ('create', 'Create the approved saved draft; authorizes the entire preflight plan'),
    ):
        example = ('jira-ticket doctor; jira-ticket doctor --connectivity' if name == 'doctor' else
                   'jira-ticket statuses --type VERIFIED_TYPE' if name == 'statuses' else
                   f'jira-ticket {name}' if name in ('types', 'link-types') else f'jira-ticket {name} --draft approved.json')
        sub = commands.add_parser(name, help=help_text, description=help_text,
                                  aliases=['dry-run'] if name == 'preflight' else [],
                                  epilog=f'Example: {example}. Draft format: jira-ticket draft-example. Never pass credentials.')
        sub.add_argument('--config', type=Path, help='Select jiratui config in this process; never pass credentials')
        if name in ('types', 'statuses'):
            sub.add_argument('--project', help='Override effective configured project')
        if name in ('preflight', 'create'):
            sub.add_argument('--draft', required=True, type=Path, help='Complete approved UTF-8 JSON draft')
        if name == 'create':
            sub.add_argument('--dry-run', action='store_true', help='Read-only preflight instead of creation; no writes')
        if name == 'statuses':
            sub.add_argument('--type', required=True, dest='issue_type')
        if name == 'doctor':
            sub.add_argument('--connectivity', action='store_true', help='Explicit read-only GET /myself; no mutations')
    return parser


def project_for(config, override=None):
    project = override or config.default_project_key_or_id
    if not isinstance(project, str) or not project or not all(c.isalnum() or c in '-_' for c in project):
        raise Failure('A valid configured or explicitly selected project key/ID is required.')
    return project


def run(args):
    if args.command == 'draft-example':
        return {'summary': 'Example only: approved replacement summary'} if args.update else example_draft()
    if args.command in ('get', 'update', 'sprints') and not issue_reference(args.issue):
        raise DraftFailure('invalid_reference', 'Target must be an existing Jira key or numeric ID.',
                           remediation='Use a verified existing Jira key (e.g. PROJECT-123) or numeric issue ID, not a URL or draft placeholder. No configuration or requests were attempted.')
    if args.command == 'sprints' and args.board is not None:
        if not args.board.isascii() or not args.board.isdigit():
            raise invalid('Board must be a numeric string verified for the existing issue project.', 'board')
    try:
        inputs = load_draft(args.draft, update=args.command == 'update') if args.command in ('preflight', 'dry-run', 'create', 'update') else None
    except DraftFailure as exc:
        if args.command == 'update':
            exc.error['remediation'] = 'Correct the saved partial draft using jira-ticket draft-example --update and its --help; rerun jira-ticket update TARGET --draft FILE --dry-run. No configuration, requests or writes were attempted.'
        raise
    try:
        config = configuration(args.config)
    except Exception:
        raise Failure('Effective jiratui configuration could not be loaded. Configure jiratui locally, select --config PATH if needed, and run jira-ticket doctor. Never share credentials or raw configuration errors.') from None
    with client_for(config) as client:
        creator = Creator(client, config.jira_base_url or config.jira_api_base_url)
        if args.command in ('get', 'update', 'sprints'):
            updater = Updater(client, config.jira_base_url or config.jira_api_base_url)
            if args.command == 'sprints':
                current = updater.read_issue(args.issue)
                return {'outcome': 'sprints', 'read_only': True, 'id': current['id'], 'key': current['key'],
                        'link': updater.browser_url + '/browse/' + current['key'],
                        'project': current['fields']['project'],
                        'boards': sprints.discover(api=updater, project_id=str(current['fields']['project']['id']), board_id=args.board)}
            if args.command == 'get':
                return {'outcome': 'issue', 'read_only': True, **updater.get(args.issue)}
            prepared = updater.prepare_update(args.issue, inputs)
            if args.dry_run:
                return {'outcome': 'dry_run', 'read_only': True, **prepared}
            return updater.update(prepared)
        if args.command == 'doctor':
            project_for(config)
            if args.connectivity:
                myself = creator.request('GET', 'myself')
                if not myself.get('accountId') or myself.get('active') is False:
                    raise Failure('Authenticated account is not active.')
            # Neither settings nor identity returned: doctor is safe to share.
            return {'outcome': 'doctor_ok', 'configuration': 'valid',
                    'connectivity': 'verified' if args.connectivity else 'not_checked',
                    'read_only': True}
        if args.command == 'link-types':
            return {'outcome': 'link_types', 'link_types': creator.link_types()}
        if inputs is not None:
            inputs['project'] = project_for(config, inputs['project'])
            prepared = creator.prepare(**inputs)
            if args.command == 'create' and not args.dry_run:
                return creator.create(prepared)
            return {'outcome': 'dry_run', **prepared,
                    'note': 'No writes. Any planned Agile estimate update precedes the status transition. Board membership and a unique direct transition can only be checked after creation; failure then is partial success. Approved links to existing tickets are applied sequentially only after estimate, status and field verification; relationship labels describe the NEW ticket perspective.'}
        project = project_for(config, args.project)
        project_data = creator.request('GET', 'project/' + project)
        project_id = str(project_data['id'])
        types = creator.pages(f'issue/createmeta/{project_id}/issuetypes', 'issueTypes')
        if args.command == 'types':
            return {'outcome': 'types', 'project': project_data['key'],
                    'types': [{'id': str(item['id']), 'name': item['name']} for item in types]}
        selected = creator.unique(types, args.issue_type, 'Issue type')
        groups = creator.request('GET', f'project/{project_id}/statuses')
        matching = [g for g in groups if str(g['id']) == str(selected['id'])]
        if len(matching) != 1:
            raise Failure('No unique status metadata for issue type.')
        return {'outcome': 'statuses', 'project': project_data['key'],
                'type': {'id': str(selected['id']), 'name': selected['name']},
                'statuses': [{'id': str(item['id']), 'name': item['name']} for item in matching[0]['statuses']]}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = parser_for_cli()
    if not argv:
        parser.print_help()
        return 0
    if argv[0] == '--dry-run':
        argv[0] = 'preflight'
    args = parser.parse_args(argv)
    try:
        result = run(args)
    except DraftFailure as exc:
        result = {'outcome': 'preflight_failed', 'message': str(exc), 'errors': [exc.error]}
    except Failure as exc:
        # doctor must redact even locally authored Failure messages: metadata
        # and injected configuration implementations are not trusted diagnostics.
        result = {'outcome': 'doctor_failed' if args.command == 'doctor' else 'preflight_failed',
                  'message': 'Local configuration or read-only connectivity check failed. Configure jiratui locally or select --config PATH; check Jira Cloud Basic auth and verified HTTPS/TLS settings. Never share credentials or raw errors.'
                  if args.command == 'doctor' else str(exc)}
    except Exception:
        result = {'outcome': 'doctor_failed' if args.command == 'doctor' else 'preflight_failed',
                  'message': 'Configuration, input or read-only request failed. Run jira-ticket doctor and check effective jiratui configuration locally; never expose credentials or raw server errors.'}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if args.command == 'draft-example' or result['outcome'] in ('doctor_ok', 'types', 'statuses', 'link_types', 'sprints', 'dry_run', 'created', 'issue', 'updated', 'unchanged') else 1

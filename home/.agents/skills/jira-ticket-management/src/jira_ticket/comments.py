"""Read and add existing-ticket comments as the authenticated Jira user.

Reading is opt-in (get --comments). Adding is a single POST, never retried, that
is verified by reading the created comment back by its immutable ID.
"""
from .core import Failure, authenticated_account, literal_text, metadata_id, strict_json, text_adf, validate_adf


def load_body(*, text_file=None, adf_file=None):
    """Validate the saved comment body before reading configuration or Jira."""
    try:
        content = (text_file or adf_file).read_text(encoding='utf-8')
    except (OSError, UnicodeError):
        raise Failure('Comment body must be a readable UTF-8 file.') from None
    if content.startswith('\ufeff'):
        raise Failure('Comment file must be UTF-8 without a byte order mark.')
    if text_file is not None:
        text = literal_text(text=content)
        if not text.strip():
            raise Failure('Comment text must be nonempty.')
        # Unlike draft descriptions (a JSON string), a text file normally ends
        # with one newline; it is a line terminator, not an empty paragraph.
        body = text_adf(text.removesuffix('\n'))
    else:
        try:
            body = strict_json(text=content)
        except Failure as exc:
            raise Failure(f'Invalid --adf-file JSON: {exc}') from None
        except ValueError:
            raise Failure('Invalid --adf-file JSON syntax.') from None
    try:
        return validate_adf(body)
    except (Failure, TypeError, AttributeError, KeyError):
        raise Failure('Invalid, empty or unsupported ADF comment body; use the documented ADF subset or literal text.') from None


def details(*, comment, author_required):
    """Project a Jira comment. Anonymous comments have no author key; that reads as null."""
    if not isinstance(comment, dict):
        raise Failure('Malformed Jira comment.')
    author = comment.get('author')
    if ('author' in comment or author_required) and (
            not isinstance(author, dict) or not isinstance(author.get('accountId'), str) or not author['accountId']):
        raise Failure('Malformed Jira comment author.')
    if not isinstance(comment.get('body'), dict) or not all(isinstance(comment.get(k), str) for k in ('created', 'updated')):
        raise Failure('Malformed Jira comment body or timestamps.')
    visibility = comment.get('visibility')
    if visibility is not None and (not isinstance(visibility, dict) or not all(isinstance(visibility.get(k), str) for k in ('type', 'value'))):
        raise Failure('Malformed Jira comment visibility.')
    return {'id': metadata_id(value=comment.get('id')),
            'author': author and {'accountId': author['accountId'], 'displayName': author.get('displayName')},
            'created': comment['created'], 'updated': comment['updated'],
            'visibility': visibility and {k: visibility[k] for k in ('type', 'value')},
            'body': comment['body']}


def read(*, api, issue_id):
    """All comments, oldest first; strict pagination fails on a changed total or repeated ID."""
    return [details(comment=item, author_required=False) for item in
            api.pages(f'issue/{issue_id}/comment', 'comments', params={'orderBy': 'created'}, strict=True, require_total=True)]


def comment_link(*, api, key, comment_id):
    return api.issue_link(key=key) + '?focusedCommentId=' + comment_id


def prepare(*, api, reference, body):
    """Read-only plan: verified target, comment permission and the authenticated author."""
    current = api.read_issue(reference)
    myself = authenticated_account(api=api)
    permissions = api.request('GET', 'mypermissions', params={'issueId': current['id'], 'permissions': 'ADD_COMMENTS'})
    granted = permissions.get('permissions') if isinstance(permissions, dict) else None
    if not isinstance(granted, dict) or not isinstance(granted.get('ADD_COMMENTS'), dict):
        raise Failure('Comment permission could not be verified.')
    if granted['ADD_COMMENTS'].get('havePermission') is not True:
        raise Failure('Authenticated account cannot add comments to this ticket.')
    return {'id': current['id'], 'key': current['key'], 'link': api.issue_link(key=current['key']),
            'summary': current['fields']['summary'],
            'author': {'accountId': myself['accountId'], 'displayName': myself.get('displayName')},
            'payload': {'body': body}}


def add(*, api, prepared):
    result = {k: prepared[k] for k in ('id', 'key', 'link')} | {
        'outcome': 'partial_failure', 'failed_step': 'comment_create', 'uncertain_operation': 'comment_create'}
    try:
        created = api.request('POST', f'issue/{prepared["id"]}/comment', json=prepared['payload'])
        result['failed_step'] = 'comment_verification'
        comment_id = metadata_id(value=created.get('id') if isinstance(created, dict) else None)
        result['comment_id'] = comment_id
        result['comment_link'] = comment_link(api=api, key=prepared['key'], comment_id=comment_id)
        comment = details(comment=api.request('GET', f'issue/{prepared["id"]}/comment/{comment_id}'), author_required=True)
        if comment['id'] != comment_id or comment['author']['accountId'] != prepared['author']['accountId']:
            raise Failure('Created comment identity or author failed verification.')
        if comment['body'] != prepared['payload']['body']:
            raise Failure('Created comment body failed verification.')
        return {'outcome': 'commented', 'id': prepared['id'], 'key': prepared['key'], 'link': prepared['link'],
                'comment': comment | {'link': result['comment_link']}}
    except Failure as exc:
        result['message'] = str(exc)
    except Exception:
        result['message'] = 'Request or verification failed.'
    result['message'] += ' The comment may have been added. Do not repeat uncertain writes.'
    result['remaining_action'] = (f'Open {result.get("comment_link", result["link"])} and check whether the approved comment exists. '
                                  'If present, do nothing. If absent, rerun comment --dry-run and obtain fresh approval; never repost an uncertain comment.')
    return result

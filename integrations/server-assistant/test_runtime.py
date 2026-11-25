"""Keyless real-profile test. Run with the ERP venv after installing python/sdk."""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

from deepseek_harness import DeepSeekHarness, DeepSeekHarnessConfig


def test_only_erp_tools_and_persisted_resume(tmp_path):
    requests = []
    auth_headers = []
    tool_requests = []
    stream_arrived = threading.Event()
    streamed = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if self.path == '/api/harness/discovery':
                tool_requests.append((payload, self.headers.get('authorization'), self.headers.get('x-harness-read-only')))
                self.send_response(200)
                self.send_header('content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"code": 0, "data": {"discovery_contract_version": 1,
                    "catalog_revision": "mock-revision", "candidates": []}}).encode())
                return
            requests.append(payload)
            auth_headers.append((self.headers.get('x-api-key'), self.headers.get('x-erp-client-id')))
            events = [
                {"type": "message_start", "message": {"id": "mock-response", "model": "deepseek-flash", "usage": {"input_tokens": 3, "output_tokens": 0}}},
                {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "模拟统计完成"}},
                {"type": "content_block_stop", "index": 0},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}},
                {"type": "message_stop"},
            ]
            if len(requests) == 1:
                events[1:5] = [
                    {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "discover-1", "name": "education_erp_discover", "input": {}}},
                    {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps({"action": "search", "question": "统计教师学历结构"}, ensure_ascii=False)}},
                    {"type": "content_block_stop", "index": 0},
                    {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 1}},
                ]
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.end_headers()
            for index, item in enumerate(events):
                self.wfile.write(f"event: {item['type']}\ndata: {json.dumps(item, ensure_ascii=False)}\n\n".encode())
                self.wfile.flush()
                if index == 2 and item.get('delta', {}).get('type') == 'text_delta':
                    # The SDK must deliver text before the HTTP model stream finishes.
                    assert stream_arrived.wait(timeout=10)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    root = Path(__file__).resolve().parents[2]
    endpoint = f'http://127.0.0.1:{server.server_port}'
    session_id = str(uuid4())
    client_id = str(uuid4())
    env = {k: v for k, v in os.environ.items() if k.upper() in ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME')}
    env.update(ERP_SERVER_API_URL=endpoint, ERP_SERVER_GATEWAY_URL=endpoint+'/anthropic', ERP_SERVER_MODEL='deepseek-flash',
               ERP_SERVER_TOOL_TIMEOUT_MS='30000', ERP_SERVER_MAX_RESPONSE_CHARS='50000', ERP_SERVER_ACCESS_TOKEN='private-erp-token',
               ERP_SERVER_GATEWAY_TOKEN='private-gateway-token', ERP_SERVER_CLIENT_ID=client_id,
               ERP_SERVER_APPROVAL_TOKEN='private-approval-token', ERP_SERVER_RUN_ID=str(uuid4()),
               ERP_SERVER_SESSION_ID=session_id, ERP_SERVER_APPROVAL_TIMEOUT_MS='90000')
    results = []
    try:
        for question in ('统计教师学历结构', '继续解释刚才的统计'):
            stream_arrived.clear()
            turn_text = []
            def notification(item):
                if item.method == 'session.text' and item.payload.get('type') == 'delta':
                    turn_text.append(item.payload['text'])
                    stream_arrived.set()
            with DeepSeekHarness(DeepSeekHarnessConfig(
                dsh_bin=str(root/'apps/cli/src/bin.ts'),
                runtime_cwd=str(root), cwd=str(tmp_path), dsh_home=str(tmp_path), profile='sdk-minimal',
                patches=(str(root/'integrations/server-assistant/cordis.patch.yml'),),
                provider='erp-gateway', model='deepseek-flash', env=env, inherit_env=False,
                max_tokens=1024, initialize_timeout_seconds=45, request_timeout_seconds=30,
            )) as harness:
                results.append(harness.run(question, session_id=session_id, on_notification=notification))
            streamed.append(''.join(turn_text))
    finally:
        server.shutdown()
        thread.join(timeout=3)
        server.server_close()
    assert [r.final_response for r in results] == ['模拟统计完成', '模拟统计完成'], [(r.finish_reason, [e['type'] for e in r.events]) for r in results]
    assert all(r.finish_reason == 'completed' for r in results)
    assert {t['name'] for t in requests[0]['tools']} == {'education_erp_discover', 'education_erp_api', 'education_erp_query'}
    assert '统计教师学历结构' in json.dumps(requests[-1], ensure_ascii=False)
    assert '模拟统计完成' in json.dumps(requests[-1], ensure_ascii=False)
    assert all(pair == ('private-gateway-token', client_id) for pair in auth_headers)
    for payload in requests:
        encoded = json.dumps(payload)
        assert 'private-erp-token' not in encoded and 'private-gateway-token' not in encoded
    assert any(e['type'] == 'assistant/message' for e in results[0].events)
    assert len(tool_requests) == 1
    assert tool_requests[0][1:] == ('Bearer private-erp-token', None)
    assert tool_requests[0][0]['action'] == 'search'
    snapshot = {
        "tools": sorted(t['name'] for t in requests[0]['tools']),
        "answers": [r.final_response for r in results],
        "discovery_action": tool_requests[0][0]['action'],
        "restored_question": '统计教师学历结构' in json.dumps(requests[-1], ensure_ascii=False),
        "restored_answer": '模拟统计完成' in json.dumps(requests[-1], ensure_ascii=False),
        "streamed_text": streamed,
    }
    expected = json.loads(Path(__file__).with_name('runtime.expected.json').read_text(encoding='utf-8'))
    assert snapshot == expected
    for log in tmp_path.rglob('*.jsonl'):
        persisted = log.read_text(encoding='utf-8')
        assert 'private-erp-token' not in persisted and 'private-gateway-token' not in persisted


def test_write_waits_for_confirmed_action_and_uses_one_time_grant(tmp_path):
    calls = []
    model_turns = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if self.path == '/api/ai/internal/write-approval':
                calls.append(('confirmation', payload, self.headers.get('x-erp-approval-token')))
                self.respond({'code': 0, 'data': {'outcome': 'allowed-once'}})
            elif self.path == '/api/harness/write-approval':
                calls.append(('grant', payload, self.headers.get('authorization')))
                self.respond({'code': 0, 'data': {'write_approval': 'one-time-grant'}})
            elif self.path == '/api/harness/api':
                calls.append(('api', payload, self.headers.get('authorization')))
                if payload.get('write_approval') == 'one-time-grant':
                    self.respond({'code': 0, 'data': {'status': 200, 'ok': True, 'data': {'status': 'completed'}}})
                else:
                    self.respond({'code': 0, 'data': {'approval_required': True}}, status=409)
            else:
                model_turns.append(payload)
                events = [
                    {'type': 'message_start', 'message': {'id': 'mock', 'model': 'deepseek-flash', 'usage': {'input_tokens': 3, 'output_tokens': 0}}},
                    {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'id': 'write-1', 'name': 'education_erp_api', 'input': {}}},
                    {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps({'method': 'POST', 'path': '/api/workflow_task/complete/123', 'body': {'comment': '同意'}}, ensure_ascii=False)}},
                    {'type': 'content_block_stop', 'index': 0},
                    {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}, 'usage': {'output_tokens': 1}},
                    {'type': 'message_stop'},
                ] if len(model_turns) == 1 else [
                    {'type': 'message_start', 'message': {'id': 'mock-2', 'model': 'deepseek-flash', 'usage': {'input_tokens': 3, 'output_tokens': 0}}},
                    {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
                    {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': '审批已完成'}},
                    {'type': 'content_block_stop', 'index': 0},
                    {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': 1}},
                    {'type': 'message_stop'},
                ]
                self.send_response(200)
                self.send_header('content-type', 'text/event-stream')
                self.end_headers()
                for item in events:
                    self.wfile.write(f"event: {item['type']}\ndata: {json.dumps(item, ensure_ascii=False)}\n\n".encode())
                    self.wfile.flush()

        def respond(self, payload, status=200):
            self.send_response(status)
            self.send_header('content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(payload, ensure_ascii=False).encode())

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    root = Path(__file__).resolve().parents[2]
    endpoint = f'http://127.0.0.1:{server.server_port}'
    session_id = str(uuid4())
    env = {k: v for k, v in os.environ.items() if k.upper() in ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME')}
    env.update(ERP_SERVER_API_URL=endpoint, ERP_SERVER_GATEWAY_URL=endpoint+'/anthropic', ERP_SERVER_MODEL='deepseek-flash',
               ERP_SERVER_TOOL_TIMEOUT_MS='30000', ERP_SERVER_MAX_RESPONSE_CHARS='50000', ERP_SERVER_ACCESS_TOKEN='private-erp-token',
               ERP_SERVER_GATEWAY_TOKEN='private-gateway-token', ERP_SERVER_CLIENT_ID=str(uuid4()),
               ERP_SERVER_APPROVAL_TOKEN='private-approval-token', ERP_SERVER_RUN_ID=str(uuid4()),
               ERP_SERVER_SESSION_ID=session_id, ERP_SERVER_APPROVAL_TIMEOUT_MS='15000')
    try:
        with DeepSeekHarness(DeepSeekHarnessConfig(
            dsh_bin=str(root/'apps/cli/src/bin.ts'), runtime_cwd=str(root), cwd=str(tmp_path), dsh_home=str(tmp_path),
            profile='sdk-minimal', patches=(str(root/'integrations/server-assistant/cordis.patch.yml'),),
            provider='erp-gateway', model='deepseek-flash', env=env, inherit_env=False,
            max_tokens=1024, initialize_timeout_seconds=45, request_timeout_seconds=30,
        )) as harness:
            result = harness.run('完成我的待办审批', session_id=session_id)
    finally:
        server.shutdown()
        thread.join(timeout=3)
        server.server_close()
    assert result.final_response == '审批已完成', (result.finish_reason, [e['type'] for e in result.events], calls)
    assert [item[0] for item in calls] == ['api', 'confirmation', 'grant', 'api']
    assert calls[1][2] == 'private-approval-token'
    assert 'POST /api/workflow_task/complete/123' in calls[1][1]['preview']
    assert calls[2][1] == calls[0][1]
    assert calls[3][1]['write_approval'] == 'one-time-grant'
    for log in tmp_path.rglob('*.jsonl'):
        persisted = log.read_text(encoding='utf-8')
        assert 'private-approval-token' not in persisted and 'one-time-grant' not in persisted

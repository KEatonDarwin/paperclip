<?php
/**
 * Apple Watch → JARVIS relay
 *
 * Accepts POST { "text": "..." } and sends it to JARVIS
 * via Slack DM (Kevin's user token → bot DM conversation).
 *
 * Deploy to any PHP-capable server (e.g. somehow.thedarwinhub.com).
 *
 * Required env vars (or edit the constants below):
 *   RELAY_AUTH_TOKEN     - shared secret the Shortcut sends as Bearer token
 *   SLACK_USER_TOKEN     - Kevin's Slack user OAuth token (xoxp-...)
 *   JARVIS_BOT_USER_ID   - Slack user ID of the JARVIS bot (U...)
 */

$AUTH_TOKEN       = getenv('RELAY_AUTH_TOKEN')    ?: 'CHANGE_ME';
$SLACK_USER_TOKEN = getenv('SLACK_USER_TOKEN')    ?: 'xoxp-CHANGE_ME';
$JARVIS_BOT_ID    = getenv('JARVIS_BOT_USER_ID') ?: 'U_CHANGE_ME';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'POST only']);
    exit;
}

$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if ($auth !== "Bearer $AUTH_TOKEN") {
    http_response_code(401);
    echo json_encode(['error' => 'unauthorized']);
    exit;
}

$body = json_decode(file_get_contents('php://input'), true);
$text = trim($body['text'] ?? '');

if ($text === '') {
    http_response_code(400);
    echo json_encode(['error' => 'text is required']);
    exit;
}

$dm = slack('conversations.open', ['users' => $JARVIS_BOT_ID], $SLACK_USER_TOKEN);
if (!($dm['ok'] ?? false)) {
    http_response_code(502);
    echo json_encode(['error' => 'failed to open DM', 'slack' => $dm]);
    exit;
}
$channel = $dm['channel']['id'];

$result = slack('chat.postMessage', [
    'channel' => $channel,
    'text'    => $text,
], $SLACK_USER_TOKEN);

if ($result['ok'] ?? false) {
    echo json_encode(['ok' => true, 'ts' => $result['ts']]);
} else {
    http_response_code(502);
    echo json_encode(['error' => 'failed to post message', 'slack' => $result]);
}

function slack(string $method, array $payload, string $token): array {
    $ch = curl_init("https://slack.com/api/$method");
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_HTTPHEADER     => [
            "Authorization: Bearer $token",
            'Content-Type: application/json; charset=utf-8',
        ],
        CURLOPT_POSTFIELDS     => json_encode($payload),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
    ]);
    $resp = curl_exec($ch);
    curl_close($ch);
    return json_decode($resp, true) ?: ['ok' => false, 'error' => 'curl_failed'];
}

const { OpenAI } = require('openai');

// OpenAI クライアントの初期化
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Netlify 等の環境変数からアシスタントIDを取得
const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;

exports.handler = async function (event, context) {
    // POSTリクエスト以外は拒否
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const { message, sessionId } = JSON.parse(event.body);
        if (!message) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Message is required' })
            };
        }

        let threadId = sessionId;
        let thread;

        // 新規スレッド作成または既存スレッドの取得
        if (!threadId) {
            thread = await openai.beta.threads.create();
            threadId = thread.id;
            console.log(`New thread created: ${threadId}`);
        } else {
            try {
                thread = await openai.beta.threads.retrieve(threadId);
                console.log(`Using existing thread: ${threadId}`);
            } catch (error) {
                console.log(`Thread ${threadId} not found, creating a new one`);
                thread = await openai.beta.threads.create();
                threadId = thread.id;
            }
        }

        // ユーザーのメッセージをスレッドに追加
        await openai.beta.threads.messages.create(threadId, {
            role: 'user',
            content: message
        });

        // アシスタントの返信をストリーミングで取得
        // Python のコードと同様、stream: true を指定
        const stream = await openai.beta.threads.runs.create(threadId, {
            assistant_id: ASSISTANT_ID,
            stream: true
        });

        // 返信のテキストを蓄積する変数
        let assistantReply = "";
        // 〖...〗 で囲まれた部分を除去するための正規表現パターン
        const regexPattern = /〖.*?〗/g;

        // ストリームから順次イベントを受け取る
        // （openai.beta.threads.runs.create が async iterable を返すことを前提）
        for await (const event of stream) {
            if (event && event.data && event.data.delta && Array.isArray(event.data.delta.content)) {
                for (const block of event.data.delta.content) {
                    if (block.type === 'text' && block.text && block.text.value) {
                        // テキストチャンクから不要な部分を除去
                        const cleanedChunk = block.text.value.replace(regexPattern, '');
                        assistantReply += cleanedChunk;
                    }
                }
            }
        }

        // 最終的なアシスタントの返信とセッションID（スレッドID）を返す
        return {
            statusCode: 200,
            body: JSON.stringify({
                response: assistantReply,
                sessionId: threadId
            })
        };

    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error' })
        };
    }
};

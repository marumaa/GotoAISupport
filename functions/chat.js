import OpenAI from "openai";

// OpenAI クライアントの初期化 (環境変数 OPENAI_API_KEY を使用)
const openai = new OpenAI();

// 環境変数からアシスタントIDを取得
const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;

export const handler = async function (event, context) {
    // POSTリクエスト以外は拒否
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        // リクエストボディを解析
        let body;
        try {
            body = JSON.parse(event.body);
        } catch (parseError) {
            console.error('Error parsing request body:', parseError);
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid request body' })
            };
        }

        const { message, sessionId, language } = body;
        if (!message) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Message is required' })
            };
        }

        // 環境変数の検証
        if (!ASSISTANT_ID) {
            console.error('OPENAI_ASSISTANT_ID environment variable is not set');
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Server configuration error' })
            };
        }

        console.log(`Processing request: language=${language}, sessionId=${sessionId || 'new'}`);

        let threadId = sessionId;
        let thread;

        // 新規スレッド作成または既存スレッドの取得
        if (!threadId) {
            try {
                thread = await openai.beta.threads.create();
                threadId = thread.id;
                console.log(`New thread created: ${threadId}`);
            } catch (error) {
                console.error('Error creating thread:', error.message);
                console.error('Error details:', error.response?.data || 'No additional details');
                return {
                    statusCode: 500,
                    body: JSON.stringify({ error: 'Failed to create conversation thread' })
                };
            }
        } else {
            try {
                thread = await openai.beta.threads.retrieve(threadId);
                console.log(`Using existing thread: ${threadId}`);
            } catch (error) {
                console.error(`Error retrieving thread ${threadId}:`, error.message);
                // スレッドが見つからない場合は新規作成
                try {
                    thread = await openai.beta.threads.create();
                    threadId = thread.id;
                    console.log(`Thread ${sessionId} not found, created new one: ${threadId}`);
                } catch (createError) {
                    console.error('Error creating replacement thread:', createError.message);
                    return {
                        statusCode: 500,
                        body: JSON.stringify({ error: 'Failed to create conversation thread' })
                    };
                }
            }
        }

        // 言語情報を含めたメッセージコンテンツの作成
        const userMessageContent = `[LANGUAGE: ${language || 'ja'}] ${message}`;

        // ユーザーのメッセージをスレッドに追加
        try {
            await openai.beta.threads.messages.create(threadId, {
                role: 'user',
                content: userMessageContent
            });
            console.log(`Added user message to thread ${threadId}`);
        } catch (error) {
            console.error('Error adding message to thread:', error.message);
            console.error('Error details:', error.response?.data || 'No additional details');
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to add message to conversation' })
            };
        }

        // Runの作成と実行
        let run;
        try {
            run = await openai.beta.threads.runs.create(threadId, {
                assistant_id: ASSISTANT_ID
            });
            console.log(`Created run ${run.id} for thread ${threadId}`);
        } catch (error) {
            console.error('Error creating run:', error.message);
            console.error('Error details:', error.response?.data || 'No additional details');
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to process your request' })
            };
        }

        // 実行完了を待つ
        let runStatus;
        let attempts = 0;
        const maxAttempts = 25; // 最大25秒待機
        
        try {
            runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
            console.log(`Initial run status: ${runStatus.status}`);
            
            // 応答待ち
            while (
                !['completed', 'failed', 'cancelled', 'expired'].includes(runStatus.status) && 
                attempts < maxAttempts
            ) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
                attempts++;
                console.log(`Run status after ${attempts} seconds: ${runStatus.status}`);
            }
            
            // エラー状態の確認
            if (['failed', 'cancelled', 'expired'].includes(runStatus.status)) {
                throw new Error(`Run ended with status: ${runStatus.status}`);
            }
            
            if (attempts >= maxAttempts) {
                throw new Error('Response timed out');
            }
        } catch (error) {
            console.error('Error during run execution:', error.message);
            return {
                statusCode: 500,
                body: JSON.stringify({ error: `Error processing message: ${error.message}` })
            };
        }

        // 完了した応答を取得
        let finalResponse;
        try {
            finalResponse = await openai.beta.threads.messages.list(threadId, {
                order: 'desc', // 最新のメッセージから取得
                limit: 1 // 最新の1件だけ取得
            });
            console.log('Retrieved final response');
        } catch (error) {
            console.error('Error retrieving messages:', error.message);
            console.error('Error details:', error.response?.data || 'No additional details');
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to retrieve assistant response' })
            };
        }
        
        // 応答テキストの取得と処理
        let responseText = '';
        try {
            // APIからの応答を確認
            if (finalResponse.data && 
                finalResponse.data.length > 0) {
                
                // 最新のメッセージを取得
                const latestMessage = finalResponse.data[0];
                
                // アシスタントの応答かどうか確認
                if (latestMessage.role === 'assistant' && 
                    latestMessage.content && 
                    latestMessage.content.length > 0) {
                    
                    // コンテンツの種類を確認
                    const textContent = latestMessage.content.find(item => item.type === 'text');
                    
                    if (textContent && textContent.text && textContent.text.value) {
                        responseText = textContent.text.value;
                        
                        // 【 または 〖 で始まる参照やメタデータを削除
                        let index = responseText.indexOf('【');
                        if (index !== -1) {
                            responseText = responseText.substring(0, index) + '.';
                        }
                        
                        // 〖...〗 で囲まれた部分を除去
                        responseText = responseText.replace(/〖.*?〗/g, '');
                        
                        console.log('Processed response text successfully');
                    } else {
                        throw new Error('No text content found in assistant response');
                    }
                } else {
                    throw new Error('Latest message is not from assistant or is in unexpected format');
                }
            } else {
                throw new Error('No messages found in response');
            }
        } catch (error) {
            console.error('Error processing response text:', error.message);
            
            // 言語に応じたエラーメッセージ
            const errorMessages = {
                'en': 'Sorry, I could not generate a proper response. Please try again.',
                'ja': '申し訳ありません。適切な応答を生成できませんでした。もう一度お試しください。',
                'ko': '죄송합니다. 적절한 응답을 생성할 수 없었습니다. 다시 시도해 주세요.',
                'zh': '抱歉，我无法生成适当的回应。请再试一次。'
            };
            
            responseText = errorMessages[language] || errorMessages['ja'];
        }

        // 最終的なアシスタントの返信とセッションID（スレッドID）を返す
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: responseText,  // 'response'から'message'に変更
                sessionId: threadId
            })
        };

    } catch (error) {
        console.error('Unhandled error:', error.message);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error' })
        };
    }
};

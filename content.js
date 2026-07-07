// Content script for Claude Conversation Exporter.
//
// Conversion + model helpers (inferModel, getCurrentBranch, convertToMarkdown,
// convertToText, ...) are provided by utils.js, which the manifest loads before
// this file in content_scripts. Only the page-specific fetch/download/message
// plumbing lives here.
//
// Organization ID is stored in extension settings (configured on the options page).

// Fetch a single conversation with its full message tree.
async function fetchConversation(orgId, conversationId) {
  const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;

  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch conversation: ${response.status}`);
  }

  return await response.json();
}

// Fetch the list of all conversations.
async function fetchAllConversations(orgId) {
  const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations`;

  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch conversations: ${response.status}`);
  }

  return await response.json();
}

// Download file utility (browser-only; kept here since utils.js is DOM-free).
function downloadFile(content, filename, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'exportConversation') {
    console.log('Export conversation request received:', request);

    fetchConversation(request.orgId, request.conversationId)
      .then(data => {
        console.log('Conversation data fetched successfully:', data);

        // Infer model if null
        data.model = inferModel(data);

        let content, filename, type;

        switch (request.format) {
          case 'markdown':
            content = convertToMarkdown(data, request.includeMetadata);
            filename = `claude-conversation-${data.name || request.conversationId}.md`;
            type = 'text/markdown';
            break;
          case 'text':
            content = convertToText(data, request.includeMetadata);
            filename = `claude-conversation-${data.name || request.conversationId}.txt`;
            type = 'text/plain';
            break;
          default:
            content = JSON.stringify(data, null, 2);
            filename = `claude-conversation-${data.name || request.conversationId}.json`;
            type = 'application/json';
        }

        console.log('Downloading file:', filename);
        downloadFile(content, filename, type);
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error('Export conversation error:', error);
        sendResponse({
          success: false,
          error: error.message,
          details: error.stack
        });
      });

    return true;
  }

  if (request.action === 'exportAllConversations') {
    console.log('Export all conversations request received:', request);

    fetchAllConversations(request.orgId)
      .then(async conversations => {
        console.log(`Fetched ${conversations.length} conversations`);

        if (request.format === 'json') {
          // For JSON, export as a single file with all conversations
          const filename = `claude-all-conversations-${new Date().toISOString().split('T')[0]}.json`;
          console.log('Downloading all conversations as JSON:', filename);
          downloadFile(JSON.stringify(conversations, null, 2), filename);
          sendResponse({ success: true, count: conversations.length });
        } else {
          // For other formats, create individual files
          let count = 0;
          let errors = [];

          for (const conv of conversations) {
            try {
              console.log(`Fetching full conversation ${count + 1}/${conversations.length}: ${conv.uuid}`);
              const fullConv = await fetchConversation(request.orgId, conv.uuid);

              // Infer model if null
              fullConv.model = inferModel(fullConv);

              let content, filename, type;

              if (request.format === 'markdown') {
                content = convertToMarkdown(fullConv, request.includeMetadata);
                filename = `claude-${conv.name || conv.uuid}.md`;
                type = 'text/markdown';
              } else {
                content = convertToText(fullConv, request.includeMetadata);
                filename = `claude-${conv.name || conv.uuid}.txt`;
                type = 'text/plain';
              }

              downloadFile(content, filename, type);
              count++;

              // Add a small delay to avoid overwhelming the API
              await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
              console.error(`Failed to export conversation ${conv.uuid}:`, error);
              errors.push(`${conv.name || conv.uuid}: ${error.message}`);
            }
          }

          if (errors.length > 0) {
            console.warn('Some conversations failed to export:', errors);
            sendResponse({
              success: true,
              count,
              warnings: `Exported ${count}/${conversations.length} conversations. Some failed: ${errors.join('; ')}`
            });
          } else {
            sendResponse({ success: true, count });
          }
        }
      })
      .catch(error => {
        console.error('Export all conversations error:', error);
        sendResponse({
          success: false,
          error: error.message,
          details: error.stack
        });
      });

    return true;
  }
});

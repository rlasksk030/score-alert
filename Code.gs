// ===== 학부모 성적조회 앱 Code.gs 전체 교체용 =====
// 이 파일은 현재 학부모 성적조회 Apps Script의 Code.gs 전체를 지우고 그대로 붙여넣는 용도입니다.
// 기존 조회 기능 + 틀린문제/정답 비교 + 학부모 푸시 알림 + GitHub Pages JSONP API가 포함되어 있습니다.
// 필요한 스크립트 속성: NOTION_TOKEN_DICTATION, NOTION_TOKEN_ENGLISH, SCORE_DETAIL_SHEET_ID, SCORE_PUSH_SECRET
function getConfig_() {
  return {
    appTitle: '학생 성적 조회',
    notionVersion: '2026-03-11',
    sessionTtlSeconds: 60 * 60 * 6,
    namesCacheTtlSeconds: 60 * 10,
    dataSources: {
      dictation: {
        id: '32056e32-ac72-81a7-b68b-000bd9610b6c',
        label: '받아쓰기',
        tokenProperty: 'NOTION_TOKEN_DICTATION'
      },
      english: {
        id: '31e56e32-ac72-800c-a2bf-000b34aa1c5c',
        label: '영어 시험',
        tokenProperty: 'NOTION_TOKEN_ENGLISH'
      }
    },
    reservedProperties: ['이름', '번호', '확인코드']
  };
}

function doGet(e) {
  if (e && e.parameter && e.parameter.api) {
    return handleScoreJsonpApi_(e);
  }

  var config = getConfig_();
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(config.appTitle)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getInitialViewModel() {
  var config = getConfig_();
  return {
    appTitle: config.appTitle,
    studentNames: getStudentNames_()
  };
}

function loginStudent(payload) {
  var config = getConfig_();
  var name = sanitizeText_(payload && payload.name);
  var pin = sanitizeText_(payload && payload.pin);

  if (!name || !pin) {
    throw new Error('이름과 PIN을 모두 입력해 주세요.');
  }

  var dictationPage = findStudentPage_(config.dataSources.dictation.id, name, pin);
  var englishPage = findStudentPage_(config.dataSources.english.id, name, pin);

  if (!dictationPage && !englishPage) {
    throw new Error('이름 또는 PIN이 올바르지 않습니다.');
  }

  var sessionToken = Utilities.getUuid();
  var session = {
    name: name,
    pin: pin,
    issuedAt: new Date().toISOString()
  };

  CacheService.getScriptCache().put(
    buildSessionKey_(sessionToken),
    JSON.stringify(session),
    config.sessionTtlSeconds
  );

  return {
    sessionToken: sessionToken,
    studentName: name
  };
}

function getStudentDashboard(sessionToken) {
  var config = getConfig_();
  var session = getSession_(sessionToken);
  var dictationPage = findStudentPage_(config.dataSources.dictation.id, session.name, session.pin);
  var englishPage = findStudentPage_(config.dataSources.english.id, session.name, session.pin);

  if (!dictationPage && !englishPage) {
    throw new Error('세션이 만료되었거나 학생 정보를 찾을 수 없습니다.');
  }

  return {
    student: {
      name: session.name,
      number: firstDefined_(
        dictationPage ? readPlainTextProperty_(dictationPage.properties['번호']) : '',
        englishPage ? readPlainTextProperty_(englishPage.properties['번호']) : ''
      )
    },
    tabs: {
      english: englishPage ? buildTabData_(englishPage, config.dataSources.english.label) : buildEmptyTab_(config.dataSources.english.label),
      dictation: dictationPage ? buildTabData_(dictationPage, config.dataSources.dictation.label) : buildEmptyTab_(config.dataSources.dictation.label)
    }
  };
}

function changeStudentPin(payload) {
  var config = getConfig_();
  var sessionToken = sanitizeText_(payload && payload.sessionToken);
  var newPin = sanitizeText_(payload && payload.newPin);
  var confirmPin = sanitizeText_(payload && payload.confirmPin);
  var session = getSession_(sessionToken);
  var dictationPage = findStudentPage_(config.dataSources.dictation.id, session.name, session.pin);
  var englishPage = findStudentPage_(config.dataSources.english.id, session.name, session.pin);

  if (!newPin || !confirmPin) {
    throw new Error('새 PIN과 확인 PIN을 모두 입력해 주세요.');
  }

  if (newPin !== confirmPin) {
    throw new Error('새 PIN과 확인 PIN이 다릅니다.');
  }

  if (!/^\d{4,8}$/.test(newPin)) {
    throw new Error('PIN은 숫자 4자리 이상 8자리 이하로 입력해 주세요.');
  }

  if (newPin === session.pin) {
    throw new Error('현재 PIN과 다른 번호를 입력해 주세요.');
  }

  if (dictationPage) {
    updateStudentPin_(config.dataSources.dictation, dictationPage.id, newPin);
  }

  if (englishPage) {
    updateStudentPin_(config.dataSources.english, englishPage.id, newPin);
  }

  CacheService.getScriptCache().put(
    buildSessionKey_(sessionToken),
    JSON.stringify({
      name: session.name,
      pin: newPin,
      issuedAt: new Date().toISOString()
    }),
    config.sessionTtlSeconds
  );

  return { ok: true };
}

function logoutStudent(sessionToken) {
  if (sessionToken) {
    CacheService.getScriptCache().remove(buildSessionKey_(sessionToken));
  }
  return { ok: true };
}

function getStudentNamesForDropdown() {
  return getStudentNames_();
}

function getStudentNames_() {
  var config = getConfig_();
  var cache = CacheService.getScriptCache();
  var cacheKey = 'student-name-options:v1';
  var cached = cache.get(cacheKey);

  if (cached) {
    return JSON.parse(cached);
  }

  var merged = {};
  Object.keys(config.dataSources).forEach(function(key) {
    var dataSource = config.dataSources[key];
    var pages = queryAllPages_(dataSource, {}, ['이름']);
    pages.forEach(function(page) {
      var name = readPlainTextProperty_(page.properties['이름']);
      if (name) {
        merged[name] = true;
      }
    });
  });

  var names = Object.keys(merged).sort(function(a, b) {
    return a.localeCompare(b, 'ko');
  });

  cache.put(cacheKey, JSON.stringify(names), config.namesCacheTtlSeconds);
  return names;
}

function findStudentPage_(dataSourceId, name, pin) {
  var dataSource = getDataSourceConfig_(dataSourceId);
  var pages = queryAllPages_(
    dataSource,
    {
      property: '이름',
      title: { equals: name }
    },
    null
  );
  var matchedPages = pages.filter(function(page) {
    return readPlainTextProperty_(page.properties && page.properties['확인코드']) === String(pin || '').trim();
  });

  if (matchedPages.length > 1) {
    throw new Error('같은 이름과 PIN 조합의 학생이 여러 명입니다. 데이터베이스를 확인해 주세요.');
  }

  return matchedPages.length ? matchedPages[0] : null;
}

function findStudentPageByName_(dataSourceId, name) {
  var dataSource = getDataSourceConfig_(dataSourceId);
  var pages = queryAllPages_(
    dataSource,
    {
      property: '이름',
      title: { equals: name }
    },
    null
  );

  if (pages.length > 1) {
    throw new Error('같은 이름의 학생이 여러 명입니다. 데이터베이스를 확인해 주세요.');
  }

  return pages.length ? pages[0] : null;
}

function findAuthorizedStudentPage_(targetKey, name, pin) {
  var config = getConfig_();
  var targetDataSource = config.dataSources[targetKey];
  var directPage = findStudentPage_(targetDataSource.id, name, pin);
  if (directPage) {
    return directPage;
  }

  var authenticatedKeys = getAuthenticatedScoreDbKeys_(name, pin, targetKey);
  if (!authenticatedKeys.length) {
    return null;
  }

  return findStudentPageByName_(targetDataSource.id, name);
}

function queryAllPages_(dataSource, filter, filterProperties) {
  var hasMore = true;
  var nextCursor = null;
  var results = [];

  while (hasMore) {
    var body = {
      page_size: 100
    };

    if (filter && Object.keys(filter).length) {
      body.filter = filter;
    }

    if (nextCursor) {
      body.start_cursor = nextCursor;
    }

    var url = 'https://api.notion.com/v1/data_sources/' + encodeURIComponent(dataSource.id) + '/query';
    if (filterProperties && filterProperties.length) {
      var queryString = filterProperties.map(function(propertyName) {
        return 'filter_properties[]=' + encodeURIComponent(propertyName);
      }).join('&');
      url += '?' + queryString;
    }

    var response = notionFetch_(url, dataSource.tokenProperty, {
      method: 'post',
      payload: JSON.stringify(body)
    });

    var parsed = JSON.parse(response.getContentText());
    (parsed.results || []).forEach(function(item) {
      if (item.object === 'page') {
        results.push(item);
      }
    });

    hasMore = parsed.has_more === true;
    nextCursor = parsed.next_cursor || null;
  }

  return results;
}

function updateStudentPin_(dataSource, pageId, newPin) {
  var url = 'https://api.notion.com/v1/pages/' + encodeURIComponent(pageId);
  notionFetch_(url, dataSource.tokenProperty, {
    method: 'patch',
    payload: JSON.stringify({
      properties: {
        '확인코드': {
          rich_text: [
            {
              type: 'text',
              text: {
                content: newPin
              }
            }
          ]
        }
      }
    })
  });
}

function notionFetch_(url, tokenPropertyName, options) {
  var config = getConfig_();
  var notionToken = getRequiredProperty_(tokenPropertyName);
  var requestOptions = Object.assign(
    {
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + notionToken,
        'Notion-Version': getOptionalProperty_('NOTION_VERSION', config.notionVersion)
      },
      muteHttpExceptions: true
    },
    options || {}
  );

  var response = UrlFetchApp.fetch(url, requestOptions);
  var statusCode = response.getResponseCode();
  if (statusCode >= 200 && statusCode < 300) {
    return response;
  }

  throw new Error('Notion API 오류 (' + statusCode + '): ' + response.getContentText());
}

function buildTabData_(page, label) {
  var config = getConfig_();
  var properties = page.properties || {};
  var scoreRows = [];
  var wrongRows = [];
  var redoRows = [];
  var studentName = readPlainTextProperty_(properties['이름']);
  var dbKey = label === '영어 시험' ? 'english' : 'dictation';

  Object.keys(properties).forEach(function(name) {
    if (isReservedScoreProperty_(config, name)) return;

    var row = {
      label: name,
      value: readDisplayValue_(properties[name]),
      sortKey: buildScoreSortKey_(name)
    };

    if (isWrongScoreProperty_(name)) {
      wrongRows.push(row);
      return;
    }

    if (isRedoScoreProperty_(name)) {
      redoRows.push(row);
      return;
    }

    scoreRows.push(row);
  });

  scoreRows.sort(sortRowBySortKey_);
  wrongRows.sort(sortRowBySortKey_);
  redoRows.sort(sortRowBySortKey_);
  scoreRows.reverse();
  wrongRows.reverse();
  redoRows.reverse();

  var wrongRowsByDate = buildRowsByDateKey_(wrongRows);
  var redoRowsByDate = buildRowsByDateKey_(redoRows);
  var groups = [];
  for (var i = 0; i < scoreRows.length; i += 1) {
    var dateKey = getScoreRowDateKey_(scoreRows[i].label);
    var redoRow = dateKey && redoRowsByDate[dateKey] ? redoRowsByDate[dateKey] : redoRows[i];
    var wrongRow = dateKey && wrongRowsByDate[dateKey] ? wrongRowsByDate[dateKey] : wrongRows[i];
    var redoValue = redoRow ? redoRow.value : '';
    var wrongValue = wrongRow ? wrongRow.value : '';
    if (!redoValue && isRedoStatusValue_(wrongValue)) {
      redoValue = wrongValue;
    }
    var details = readParentScoreDetail_(dbKey, studentName, scoreRows[i].label);
    var scoreInfo = buildScoreInfoForParent_(dbKey, scoreRows[i].label, scoreRows[i].value, details);
    groups.push({
      dateLabel: scoreRows[i].label,
      scoreValue: scoreInfo.scoreValue,
      rawScoreValue: scoreRows[i].value,
      wrongSentenceValue: wrongValue,
      wrongCount: scoreInfo.wrongCount,
      totalQuestions: scoreInfo.totalQuestions,
      correctCount: scoreInfo.correctCount,
      statusValue: wrongValue,
      absent: isAbsentStatusValue_(wrongValue) || isAbsentStatusValue_(scoreRows[i].value),
      redoValue: redoValue,
      redone: isRedoDoneValue_(redoValue),
      details: details
    });
  }

  return {
    label: label,
    number: readPlainTextProperty_(properties['번호']),
    groups: groups,
    empty: false
  };
}

function buildEmptyTab_(label) {
  return {
    label: label,
    number: '',
    groups: [],
    empty: true
  };
}

function sortRowBySortKey_(a, b) {
  return a.sortKey.localeCompare(b.sortKey, 'en');
}

function buildRowsByDateKey_(rows) {
  var map = {};
  (rows || []).forEach(function(row) {
    var key = getScoreRowDateKey_(row && row.label);
    if (key && !map[key]) {
      map[key] = row;
    }
  });
  return map;
}

function getScoreRowDateKey_(label) {
  var text = String(label || '');
  if (!/(\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}[.\/-]\d{1,2})/.test(text)) {
    return '';
  }
  return normalizeScoreDetailDateLabel_(text);
}

function buildSortKey_(label) {
  var statusMatch = label.match(/^틀린 문장(?: \((\d+)\))?$/);
  if (statusMatch) {
    var index = statusMatch[1] ? Number(statusMatch[1]) : 0;
    return 'status-' + padNumber_(index, 3);
  }

  var koreanDateMatch = label.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (koreanDateMatch) {
    return 'score-' + padNumber_(Number(koreanDateMatch[1]), 2) + '-' + padNumber_(Number(koreanDateMatch[2]), 2);
  }

  var dateMatch = label.match(/(\d{1,2})[.\/-](\d{1,2})/);
  if (dateMatch) {
    return 'score-' + padNumber_(Number(dateMatch[1]), 2) + '-' + padNumber_(Number(dateMatch[2]), 2);
  }

  return 'other-' + label;
}

function padNumber_(value, size) {
  var text = String(value);
  while (text.length < size) {
    text = '0' + text;
  }
  return text;
}

function readDisplayValue_(property) {
  if (!property) {
    return '';
  }

  switch (property.type) {
    case 'title':
      return property.title.map(function(item) { return item.plain_text; }).join('');
    case 'rich_text':
      return property.rich_text.map(function(item) { return item.plain_text; }).join('');
    case 'number':
      return property.number === null ? '' : String(property.number);
    case 'status':
      return property.status ? property.status.name : '';
    case 'select':
      return property.select ? property.select.name : '';
    case 'checkbox':
      return property.checkbox ? 'TRUE' : 'FALSE';
    case 'date':
      return property.date ? property.date.start : '';
    case 'formula':
      return readFormulaValue_(property.formula);
    default:
      if (typeof property[property.type] === 'string') {
        return property[property.type];
      }
      return '';
  }
}

function readPlainTextProperty_(property) {
  return readDisplayValue_(property);
}

function readFormulaValue_(formula) {
  if (!formula) {
    return '';
  }

  switch (formula.type) {
    case 'string':
      return formula.string || '';
    case 'number':
      return formula.number === null ? '' : String(formula.number);
    case 'boolean':
      return formula.boolean ? 'true' : 'false';
    case 'date':
      return formula.date ? formula.date.start : '';
    default:
      return '';
  }
}

function getSession_(sessionToken) {
  var normalizedToken = sanitizeText_(sessionToken);
  if (!normalizedToken) {
    throw new Error('세션 정보가 없습니다.');
  }

  var payload = CacheService.getScriptCache().get(buildSessionKey_(normalizedToken));
  if (!payload) {
    throw new Error('로그인 세션이 만료되었습니다. 다시 로그인해 주세요.');
  }

  return JSON.parse(payload);
}

function buildSessionKey_(sessionToken) {
  return 'student-session:' + sessionToken;
}

function getDataSourceConfig_(dataSourceId) {
  var config = getConfig_();
  var dataSourceKeys = Object.keys(config.dataSources);
  for (var i = 0; i < dataSourceKeys.length; i += 1) {
    var dataSource = config.dataSources[dataSourceKeys[i]];
    if (dataSource.id === dataSourceId) {
      return dataSource;
    }
  }

  throw new Error('알 수 없는 데이터 소스입니다: ' + dataSourceId);
}

function getRequiredProperty_(key) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new Error('스크립트 속성 ' + key + ' 가 설정되지 않았습니다.');
  }
  return value;
}

function getOptionalProperty_(key, fallbackValue) {
  return PropertiesService.getScriptProperties().getProperty(key) || fallbackValue;
}

function sanitizeText_(value) {
  return String(value || '').trim();
}

function firstDefined_() {
  for (var i = 0; i < arguments.length; i += 1) {
    if (arguments[i]) {
      return arguments[i];
    }
  }
  return '';
}

// ===== 학부모 알림/상세비교/GitHub API 추가 함수 =====
var SCORE_DETAIL_SHEET_ID_FALLBACK = '1yKb6NMaNxIc2GFrSWCftwhRrY1mi0KaCSUWK4K0XMWE';
var SCORE_PUSH_SERVER_URL = 'https://okgu-push-server030.vercel.app';
var SCORE_APP_URL = 'https://rlasksk030.github.io/score-alert/';
var SCORE_PUSH_INDEX_KEY = 'scoreParentPushIndex_v2';
var SCORE_SNAPSHOT_KEY = 'scoreNotionSnapshot_v3';

function handleScoreJsonpApi_(e) {
  var api = String(e.parameter.api || '');
  var callback = String(e.parameter.callback || 'callback').replace(/[^\w.$]/g, '');
  var result;

  try {
    if (api === 'getStudentList') {
      result = getStudentList(e.parameter.dbType);
    } else if (api === 'getStudentData') {
      result = getStudentData(e.parameter.name, e.parameter.password, e.parameter.dbType);
    } else if (api === 'updatePassword') {
      result = updatePassword(e.parameter.pageId, e.parameter.newPassword, e.parameter.dbType);
    } else if (api === 'updateLoggedInPasswordAll') {
      result = updateLoggedInPasswordAll(e.parameter.name, e.parameter.oldPassword, e.parameter.newPassword);
    } else if (api === 'saveParentPushSubscription') {
      result = saveParentPushSubscription(e.parameter.name, e.parameter.password, e.parameter.dbType, e.parameter.subscriptionJson);
    } else if (api === 'getParentPushStatus') {
      result = getParentPushStatus(e.parameter.name, e.parameter.password, e.parameter.dbType, e.parameter.subscriptionJson);
    } else if (api === 'sendParentPushTest') {
      result = sendParentPushTest(e.parameter.name, e.parameter.password, e.parameter.dbType);
    } else {
      result = { success: false, message: '지원하지 않는 API입니다: ' + api };
    }
  } catch (err) {
    result = { success: false, message: err && err.message ? err.message : String(err) };
  }

  return ContentService
    .createTextOutput(callback + '(' + JSON.stringify(result) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function getStudentList(dbType) {
  var key = normalizeScoreDbType_(dbType);
  var config = getConfig_();
  var dataSource = config.dataSources[key];
  var pages = queryAllPages_(dataSource, {}, ['이름']);
  var names = {};

  pages.forEach(function(page) {
    var name = readPlainTextProperty_(page.properties && page.properties['이름']);
    if (name) names[name] = true;
  });

  return Object.keys(names).sort(function(a, b) {
    return a.localeCompare(b, 'ko');
  }).map(function(name) {
    return { name: name };
  });
}

function getStudentData(name, password, dbType) {
  var key = normalizeScoreDbType_(dbType);
  var config = getConfig_();
  var dataSource = config.dataSources[key];
  var page = findAuthorizedStudentPage_(key, name, password);

  if (!page) {
    return { success: false, message: '이름 또는 확인코드가 올바르지 않습니다.' };
  }

  return {
    success: true,
    pageId: page.id,
    isFirst: false,
    studentInfo: buildStudentInfoForDesign_(page, dataSource.label, key)
  };
}

function updatePassword(pageId, newPassword, dbType) {
  var key = normalizeScoreDbType_(dbType);
  var config = getConfig_();
  if (!/^\d{4}$/.test(String(newPassword || ''))) {
    throw new Error('확인코드는 숫자 4자리로 입력해 주세요.');
  }
  updateStudentPin_(config.dataSources[key], pageId, newPassword);
  return { success: true };
}

function updateLoggedInPasswordAll(name, oldPassword, newPassword) {
  var config = getConfig_();
  var studentName = String(name || '').trim();
  var oldPin = String(oldPassword || '').trim();
  var newPin = String(newPassword || '').trim();
  var updated = [];

  if (!studentName || !oldPin) {
    return { success: false, message: '학생 이름과 현재 확인코드가 필요합니다.', code: 'AUTH' };
  }

  if (!/^\d{4}$/.test(newPin)) {
    return { success: false, message: '확인코드는 숫자 4자리로 입력해 주세요.', code: 'PIN' };
  }

  if (newPin === oldPin) {
    return { success: false, message: '현재 확인코드와 다른 번호를 입력해 주세요.', code: 'SAME_PIN' };
  }

  var authenticatedKeys = getAuthenticatedScoreDbKeys_(studentName, oldPin, 'english');
  if (!authenticatedKeys.length) {
    return { success: false, message: '현재 확인코드가 맞는 시험 정보를 찾지 못했습니다.', code: 'AUTH' };
  }

  ['english', 'dictation'].forEach(function(key) {
    var dataSource = config.dataSources[key];
    var page = findStudentPageByName_(dataSource.id, studentName);
    if (!page) return;

    updateStudentPin_(dataSource, page.id, newPin);
    updated.push({
      dbType: key,
      pageId: page.id
    });
  });

  return { success: true, updated: updated.length, pages: updated };
}

function buildStudentInfoForDesign_(page, label, dbKey) {
  var properties = page.properties || {};
  var tab = buildTabData_(page, label);
  var sessions = (tab.groups || []).map(function(group) {
    return {
      date: group.dateLabel,
      score: group.scoreValue,
      redone: group.redone,
      redoValue: group.redoValue,
      statusValue: group.statusValue,
      absent: group.absent,
      wrongCount: group.wrongCount,
      totalQuestions: group.totalQuestions,
      correctCount: group.correctCount,
      wrong: detailItemsToWrongPairs_(group.details, group.wrongSentenceValue, group.wrongCount)
    };
  });

  return {
    name: readPlainTextProperty_(properties['이름']),
    number: readPlainTextProperty_(properties['번호']),
    dbType: dbKey,
    sessions: sessions,
    redoLog: sessions.map(function(item) {
      var normalizedStatus = String(item.statusValue || item.redoValue || '').replace(/\s/g, '');
      return {
        date: item.date,
        done: item.redone,
        label: item.redoValue || item.statusValue || '',
        absent: item.absent,
        notRequired: item.absent || normalizedStatus === '백점' || Number(item.wrongCount || 0) === 0
      };
    })
  };
}

function detailItemsToWrongPairs_(details, wrongText, wrongCount) {
  if (details && details.length) {
    return details
      .filter(function(item) { return item.isWrong !== false; })
      .map(function(item) {
        return {
          mine: item.studentAnswer || item.mine || '',
          correct: item.correctAnswer || item.correct || '',
          question: item.question || '',
          no: item.no || ''
        };
      });
  }

  if (!wrongText || /틀린.*없|참 잘했|만점/.test(String(wrongText)) || isRedoStatusValue_(wrongText)) {
    if (Number(wrongCount) > 0) {
      return buildUnknownWrongPairs_(Number(wrongCount));
    }
    return [];
  }

  return String(wrongText).split(/\r?\n|,/).map(function(line) {
    return line.trim();
  }).filter(Boolean).map(function(line) {
    return { mine: line, correct: '상세 정답은 다음 시험 제출부터 표시됩니다.' };
  });
}

function buildScoreInfoForParent_(dbType, dateLabel, rawValue, details) {
  var wrongCount = parseWrongCount_(rawValue);
  if (details && details.length) {
    wrongCount = details.filter(function(item) { return item.isWrong !== false; }).length;
  }

  var totalQuestions = getTotalQuestionsForScore_(dbType, dateLabel, details);
  var correctCount = totalQuestions !== null && wrongCount !== null
    ? Math.max(0, totalQuestions - wrongCount)
    : null;

  return {
    wrongCount: wrongCount,
    totalQuestions: totalQuestions,
    correctCount: correctCount,
    scoreValue: correctCount !== null && totalQuestions !== null
      ? correctCount + '/' + totalQuestions
      : String(rawValue || '')
  };
}

function getTotalQuestionsForScore_(dbType, dateLabel, details) {
  var match = String(dateLabel || '').match(/\((\d+)\s*(?:문제|문장|단어|개)\)/);
  if (match) return Number(match[1]);

  if (details && details.length) {
    return details.length;
  }

  if (dbType === 'dictation') return 10;
  return null;
}

function parseWrongCount_(value) {
  if (value === null || value === undefined || value === '') return null;
  var match = String(value).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function buildUnknownWrongPairs_(count) {
  var pairs = [];
  for (var i = 0; i < count; i += 1) {
    pairs.push({
      mine: '틀린 문제 ' + (i + 1),
      correct: '정답 비교는 다음 시험 제출부터 표시됩니다.'
    });
  }
  return pairs;
}

function readParentScoreDetail_(dbType, studentName, dateLabel) {
  try {
    var sheetId = getScoreDetailSheetId_();
    if (!sheetId) return [];

    var ss = SpreadsheetApp.openById(sheetId);
    var sheet = ss.getSheetByName('상세결과');
    if (!sheet) return [];

    var key = buildScoreDetailKey_(dbType, studentName, dateLabel);
    var values = sheet.getDataRange().getValues();
    var exactRows = [];
    for (var i = 1; i < values.length; i += 1) {
      if (String(values[i][0]) !== key) continue;
      exactRows.push(values[i]);
    }

    if (exactRows.length) {
      exactRows.sort(function(a, b) {
        return String(b[5] || '').localeCompare(String(a[5] || ''));
      });
      var parsed = JSON.parse(String(exactRows[0][4] || '{}'));
      return parsed.items || [];
    }

    var normalizedTarget = normalizeScoreDetailDateLabel_(dateLabel);
    var fallbackRows = [];
    for (var j = 1; j < values.length; j += 1) {
      if (String(values[j][1] || '').trim() !== String(dbType || '').trim()) continue;
      if (String(values[j][2] || '').trim() !== String(studentName || '').trim()) continue;
      if (normalizeScoreDetailDateLabel_(values[j][3]) !== normalizedTarget) continue;
      fallbackRows.push(values[j]);
    }

    if (fallbackRows.length) {
      fallbackRows.sort(function(a, b) {
        return String(b[5] || '').localeCompare(String(a[5] || ''));
      });
      var fallbackParsed = JSON.parse(String(fallbackRows[0][4] || '{}'));
      return fallbackParsed.items || [];
    }
  } catch (err) {
    console.log('상세 비교 조회 실패: ' + err.message);
  }
  return [];
}

function debugParentScoreDetailLookup() {
  var dbType = 'english';
  var studentName = '이다인';
  var dateLabel = '6.15(3문제)';
  var details = readParentScoreDetail_(dbType, studentName, dateLabel);
  var result = {
    dbType: dbType,
    studentName: studentName,
    dateLabel: dateLabel,
    key: buildScoreDetailKey_(dbType, studentName, dateLabel),
    detailCount: details.length,
    wrongCount: details.filter(function(item) { return item.isWrong !== false; }).length,
    firstItem: details[0] || null
  };
  console.log('[상세결과 진단]', JSON.stringify(result));
  return result;
}

function debugParentDictationDetailLookup() {
  return debugParentLatestScoreDetailLookup_('dictation', '이다인');
}

function debugParentEnglishLatestDetailLookup() {
  return debugParentLatestScoreDetailLookup_('english', '이다인');
}

function debugParentLatestScoreDetailLookup_(dbType, studentName) {
  var sheetId = getScoreDetailSheetId_();
  var ss = SpreadsheetApp.openById(sheetId);
  var sheet = ss.getSheetByName('상세결과');
  if (!sheet) {
    var noSheet = { success: false, message: '상세결과 시트가 없습니다.' };
    console.log('[상세결과 최신 진단]', JSON.stringify(noSheet));
    return noSheet;
  }

  var values = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i += 1) {
    if (String(values[i][1] || '').trim() !== dbType) continue;
    if (String(values[i][2] || '').trim() !== studentName) continue;
    rows.push(values[i]);
  }

  rows.sort(function(a, b) {
    return String(b[5] || '').localeCompare(String(a[5] || ''));
  });

  if (!rows.length) {
    var empty = {
      success: true,
      dbType: dbType,
      studentName: studentName,
      found: false,
      message: studentName + ' 학생의 ' + dbType + ' 상세결과 행이 없습니다.'
    };
    console.log('[상세결과 최신 진단]', JSON.stringify(empty));
    return empty;
  }

  var row = rows[0];
  var parsed = JSON.parse(String(row[4] || '{}'));
  var items = parsed.items || [];
  var result = {
    success: true,
    found: true,
    dbType: dbType,
    studentName: studentName,
    dateLabel: row[3],
    key: row[0],
    detailCount: items.length,
    wrongCount: items.filter(function(item) { return item.isWrong !== false; }).length,
    firstWrongItem: items.filter(function(item) { return item.isWrong !== false; })[0] || null,
    updatedAt: row[5]
  };
  console.log('[상세결과 최신 진단]', JSON.stringify(result));
  return result;
}

function saveParentPushSubscription(name, password, dbType, subscriptionJson) {
  var key = normalizeScoreDbType_(dbType);
  var subscription;
  try {
    subscription = JSON.parse(subscriptionJson);
  } catch (err) {
    return scoreErr_('푸시 구독 정보가 올바르지 않습니다.', 'BAD_SUBSCRIPTION');
  }

  if (!subscription || !subscription.endpoint) {
    return scoreErr_('푸시 endpoint가 없습니다.', 'BAD_SUBSCRIPTION');
  }

  var authenticatedKeys = getReadableScoreDbKeys_(name, password, key);
  if (!authenticatedKeys.length) {
    return scoreErr_('학생 이름 또는 확인코드가 맞지 않습니다.', 'AUTH');
  }

  var pushKey = scorePushKey_(subscription.endpoint);
  scoreProps_().setProperty(pushKey, JSON.stringify({
    name: String(name || '').trim(),
    dbType: key,
    dbTypes: authenticatedKeys,
    endpoint: subscription.endpoint,
    subscription: subscription,
    active: true,
    updatedAt: new Date().toISOString()
  }));

  var index = scoreIndex_();
  authenticatedKeys.forEach(function(dbKey) {
    var studentKey = studentPushIndexKey_(dbKey, name);
    index[studentKey] = index[studentKey] || [];
    if (index[studentKey].indexOf(pushKey) < 0) index[studentKey].push(pushKey);
  });
  saveScoreIndex_(index);

  return scoreOk_({
    message: '학부모 푸시 알림이 등록되었습니다.',
    enabled: true,
    registeredDbTypes: authenticatedKeys
  });
}

function getParentPushStatus(name, password, dbType, subscriptionJson) {
  var key = normalizeScoreDbType_(dbType);
  var page = findAuthorizedStudentPage_(key, name, password);
  if (!page) return scoreErr_('학생 이름 또는 확인코드가 맞지 않습니다.', 'AUTH');

  var subscription;
  try {
    subscription = JSON.parse(subscriptionJson || '{}');
  } catch (err) {
    return scoreErr_('푸시 구독 정보가 올바르지 않습니다.', 'BAD_SUBSCRIPTION');
  }

  if (!subscription || !subscription.endpoint) {
    return scoreErr_('푸시 endpoint가 없습니다.', 'BAD_SUBSCRIPTION');
  }

  var pushKey = scorePushKey_(subscription.endpoint);
  var raw = scoreProps_().getProperty(pushKey);
  if (!raw) return scoreOk_({ enabled: false });

  var item;
  try {
    item = JSON.parse(raw);
  } catch (err2) {
    return scoreOk_({ enabled: false });
  }

  if (!item || item.active === false || item.endpoint !== subscription.endpoint) {
    return scoreOk_({ enabled: false });
  }

  var readableKeys = getReadableScoreDbKeys_(name, password, key);
  var index = scoreIndex_();
  var changed = false;
  item.dbTypes = item.dbTypes || [];
  readableKeys.forEach(function(dbKey) {
    var studentKey = studentPushIndexKey_(dbKey, name);
    index[studentKey] = index[studentKey] || [];
    if (index[studentKey].indexOf(pushKey) < 0) {
      index[studentKey].push(pushKey);
      changed = true;
    }
    if (item.dbTypes.indexOf(dbKey) < 0) {
      item.dbTypes.push(dbKey);
      changed = true;
    }
  });
  if (changed) {
    scoreProps_().setProperty(pushKey, JSON.stringify(item));
    saveScoreIndex_(index);
  }

  return scoreOk_({
    enabled: true,
    registeredDbTypes: item.dbTypes || [item.dbType || key]
  });
}

function getAuthenticatedScoreDbKeys_(name, password, preferredKey) {
  var config = getConfig_();
  var order = [preferredKey, preferredKey === 'english' ? 'dictation' : 'english'];
  var keys = [];

  order.forEach(function(key) {
    if (!key || keys.indexOf(key) >= 0) return;
    var page = findStudentPage_(config.dataSources[key].id, name, password);
    if (page) keys.push(key);
  });

  return keys;
}

function getReadableScoreDbKeys_(name, password, preferredKey) {
  var authenticatedKeys = getAuthenticatedScoreDbKeys_(name, password, preferredKey);
  if (!authenticatedKeys.length) return [];

  var config = getConfig_();
  return ['english', 'dictation'].filter(function(key) {
    return !!findStudentPageByName_(config.dataSources[key].id, name);
  });
}

function sendParentPushTest(name, password, dbType) {
  var key = normalizeScoreDbType_(dbType);
  var page = findAuthorizedStudentPage_(key, name, password);
  if (!page) return scoreErr_('학생 이름 또는 확인코드가 맞지 않습니다.', 'AUTH');

  return sendScorePushToParent_(
    key,
    name,
    '옥구초 성적 알림 테스트',
    name + ' 학생의 성적 푸시 알림이 정상 등록되었습니다.',
    'score-test-' + Date.now()
  );
}

function installScorePushMonitor() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction && trigger.getHandlerFunction() === 'checkScoreParentNotificationChanges') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('checkScoreParentNotificationChanges')
    .timeBased()
    .everyMinutes(5)
    .create();

  checkScoreParentNotificationChanges();
  return scoreOk_({ message: '5분마다 성적/오답쓰기 변경을 확인하는 트리거를 만들었습니다.' });
}

function checkScoreParentNotificationChanges() {
  var oldSnapshot = loadScoreSnapshot_();
  var nextSnapshot = {};
  var changed = [];
  var config = getConfig_();

  ['english', 'dictation'].forEach(function(key) {
    var dataSource = config.dataSources[key];
    var pages = queryAllPages_(dataSource, {}, null);

    pages.forEach(function(page) {
      var props = page.properties || {};
      var name = readPlainTextProperty_(props['이름']);
      if (!name) return;

      var snapshotKey = key + '|' + name;
      var state = scoreStateFromProperties_(props);
      var previous = oldSnapshot[snapshotKey];
      nextSnapshot[snapshotKey] = state;

      if (!previous) return;

      var oldHash = scoreHash_(JSON.stringify(previous));
      var newHash = scoreHash_(JSON.stringify(state));
      if (oldHash === newHash) return;

      var changeKind = detectScoreChangeKind_(previous, state);
      var label = dataSource.label;
      var statusLabel = scoreChangeStatusLabel_(previous, state);
      var title = changeKind === 'redo'
        ? '옥구초 오답 다시쓰기 알림'
        : '옥구초 성적 결과 알림';
      var body = changeKind === 'redo'
        ? name + ' 학생의 ' + label + ' 오답 다시쓰기 상태가 ' + (statusLabel ? statusLabel + '로 ' : '') + '변경되었습니다.'
        : name + ' 학생의 ' + label + ' 결과가 새로 등록되거나 수정되었습니다.';

      var sendResult = sendScorePushToParent_(
        key,
        name,
        title,
        body,
        'score-change-' + key + '-' + scoreHash_(name).slice(0, 10) + '-' + Date.now()
      );
      changed.push({ dbType: key, name: name, kind: changeKind, sendResult: sendResult });
      console.log('[성적알림 변경감지]', JSON.stringify({
        dbType: key,
        name: name,
        kind: changeKind,
        sendResult: sendResult
      }));
    });
  });

  saveScoreSnapshot_(nextSnapshot);
  var result = scoreOk_({ changed: changed.length, items: changed });
  console.log('[성적알림 감시결과]', JSON.stringify(result));
  return result;
}

function scoreStateFromProperties_(props) {
  var config = getConfig_();
  var state = {};

  Object.keys(props || {}).sort().forEach(function(name) {
    if (isReservedScoreProperty_(config, name)) return;
    var value = readDisplayValue_(props[name]);
    if (value === '') return;
    state[name] = value;
  });

  return state;
}

function detectScoreChangeKind_(oldState, newState) {
  var changedKeys = {};
  Object.keys(oldState || {}).forEach(function(key) {
    if (oldState[key] !== newState[key]) changedKeys[key] = true;
  });
  Object.keys(newState || {}).forEach(function(key) {
    if (oldState[key] !== newState[key]) changedKeys[key] = true;
  });

  var keys = Object.keys(changedKeys);
  if (keys.length && keys.every(function(key) {
    if (isRedoScoreProperty_(key)) return true;
    if (!isWrongScoreProperty_(key)) return false;
    return isRedoStatusValue_(oldState[key]) || isRedoStatusValue_(newState[key]);
  })) return 'redo';
  return 'score';
}

function scoreChangeStatusLabel_(oldState, newState) {
  var changedKeys = {};
  Object.keys(oldState || {}).forEach(function(key) {
    if (oldState[key] !== newState[key]) changedKeys[key] = true;
  });
  Object.keys(newState || {}).forEach(function(key) {
    if (oldState[key] !== newState[key]) changedKeys[key] = true;
  });

  var labels = [];
  Object.keys(changedKeys).forEach(function(key) {
    var value = String(newState[key] || '').trim();
    if (!value || !isRedoStatusValue_(value)) return;
    if (labels.indexOf(value) < 0) labels.push(value);
  });

  return labels.join(', ');
}

function sendScorePushToParent_(dbType, name, title, body, tag) {
  var secret = scorePushSecret_();
  if (!secret) return scoreErr_('스크립트 속성 SCORE_PUSH_SECRET이 없습니다.', 'NO_SECRET');

  var index = scoreIndex_();
  var keys = index[studentPushIndexKey_(dbType, name)] || [];
  var subscriptions = [];

  keys.forEach(function(key) {
    var raw = scoreProps_().getProperty(key);
    if (!raw) return;
    try {
      var item = JSON.parse(raw);
      if (item && item.active !== false && item.subscription && item.subscription.endpoint) {
        subscriptions.push(item.subscription);
      }
    } catch (err) {}
  });

  if (!subscriptions.length) return scoreOk_({ sent: 0, message: '등록된 학부모 기기가 없습니다.' });

  var response = UrlFetchApp.fetch(SCORE_PUSH_SERVER_URL.replace(/\/$/, '') + '/api/send-push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret },
    payload: JSON.stringify({
      subscriptions: subscriptions,
      title: title || '옥구초 성적 알림',
      body: body || '성적 정보가 변경되었습니다.',
      tag: tag || ('score-' + dbType + '-' + Date.now()),
      url: SCORE_APP_URL,
      badgeCount: 1
    }),
    muteHttpExceptions: true
  });

  var text = response.getContentText();
  if (response.getResponseCode() >= 300) return scoreErr_('푸시 서버 오류: ' + text, 'PUSH_SERVER');

  var data = {};
  try {
    data = JSON.parse(text);
  } catch (err) {
    data = { raw: text };
  }
  return scoreOk_(data);
}

function normalizeScoreDbType_(dbType) {
  var value = String(dbType || '').trim();
  if (value === 'exam1' || value === 'english' || value === '영어 시험') return 'english';
  if (value === 'exam2' || value === 'dictation' || value === '받아쓰기') return 'dictation';
  throw new Error('알 수 없는 시험 종류입니다: ' + value);
}

function isReservedScoreProperty_(config, name) {
  if ((config.reservedProperties || []).indexOf(name) !== -1) return true;
  return name === '상세결과' || name === '초기비번변경';
}

function isWrongScoreProperty_(name) {
  return /^틀린\s*(문제|문장)/.test(String(name || ''));
}

function isRedoScoreProperty_(name) {
  return /(오답|다시\s*쓰기|다시\s*써오기|10\s*번\s*쓰기|10\s*번\s*써오기|고쳐\s*쓰기|재제출)/.test(String(name || ''));
}

function isRedoDoneValue_(value) {
  var text = String(value || '').trim();
  return /완료|제출|확인|했|씀|O|TRUE|true|✅/.test(text) && !/미|안|아직|X|FALSE|false/.test(text);
}

function isRedoStatusValue_(value) {
  var text = String(value || '').trim();
  return /^(완료|미완료|백점|시험안봄|제출|미제출|확인|확인완료|아직|TRUE|FALSE|true|false|O|X|✅)$/.test(text);
}

function isAbsentStatusValue_(value) {
  var text = String(value || '').replace(/\s/g, '');
  return text === '시험안봄';
}

function buildScoreSortKey_(label) {
  var text = String(label || '');
  var dateKey = buildSortKey_(text);
  if (dateKey.indexOf('score-') === 0) {
    return dateKey;
  }

  var wrongMatch = text.match(/^틀린\s*(?:문제|문장)(?:\s*\((\d+)\))?$/);
  if (wrongMatch) return 'wrong-' + padNumber_(wrongMatch[1] ? Number(wrongMatch[1]) : 0, 3);

  var redoMatch = text.match(/(?:오답|다시\s*쓰기|다시\s*써오기|10\s*번\s*쓰기|10\s*번\s*써오기|고쳐\s*쓰기|재제출)(?:\s*\((\d+)\))?/);
  if (redoMatch) return 'redo-' + padNumber_(redoMatch[1] ? Number(redoMatch[1]) : 0, 3);

  return buildSortKey_(text);
}

function buildScoreDetailKey_(dbType, studentName, dateLabel) {
  return [dbType, studentName, dateLabel].map(function(value) {
    return String(value || '').trim().replace(/\|/g, '/');
  }).join('|');
}

function normalizeScoreDetailDateLabel_(dateLabel) {
  var text = String(dateLabel || '')
    .replace(/\s/g, '')
    .replace(/·최근/g, '')
    .replace(/\(\d+(?:문제|문장|단어|개|문항)\)/g, '');

  var koreanMatch = text.match(/(\d{1,2})월(\d{1,2})일/);
  if (koreanMatch) return Number(koreanMatch[1]) + '.' + Number(koreanMatch[2]);

  var dotMatch = text.match(/(\d{1,2})[.\/-](\d{1,2})/);
  if (dotMatch) return Number(dotMatch[1]) + '.' + Number(dotMatch[2]);

  return text;
}

function getScoreDetailSheetId_() {
  return PropertiesService.getScriptProperties().getProperty('SCORE_DETAIL_SHEET_ID') || SCORE_DETAIL_SHEET_ID_FALLBACK;
}

function scoreOk_(data) {
  var result = { success: true };
  Object.keys(data || {}).forEach(function(key) { result[key] = data[key]; });
  return result;
}

function scoreErr_(message, code) {
  return { success: false, message: message, code: code || 'ERROR' };
}

function scoreProps_() {
  return PropertiesService.getScriptProperties();
}

function scorePushSecret_() {
  return scoreProps_().getProperty('SCORE_PUSH_SECRET') || '';
}

function scoreHash_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text || ''));
  return bytes.map(function(b) {
    var v = (b + 256) % 256;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

function scoreIndex_() {
  var raw = scoreProps_().getProperty(SCORE_PUSH_INDEX_KEY);
  return raw ? JSON.parse(raw) : {};
}

function saveScoreIndex_(index) {
  scoreProps_().setProperty(SCORE_PUSH_INDEX_KEY, JSON.stringify(index || {}));
}

function scorePushKey_(endpoint) {
  return 'scorePushSub_' + scoreHash_(endpoint).slice(0, 32);
}

function studentPushIndexKey_(dbType, name) {
  return String(dbType || '').trim() + '|' + String(name || '').trim();
}

function loadScoreSnapshot_() {
  var raw = scoreProps_().getProperty(SCORE_SNAPSHOT_KEY);
  return raw ? JSON.parse(raw) : {};
}

function saveScoreSnapshot_(snapshot) {
  scoreProps_().setProperty(SCORE_SNAPSHOT_KEY, JSON.stringify(snapshot || {}));
}

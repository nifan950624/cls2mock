#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const csv = require('csvtojson');
const yazl = require('yazl');

// 解析命令行参数
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('用法: csv2mock <csv文件路径>');
  process.exit(1);
}
const csvFile = path.resolve(process.cwd(), args[0]);
if (!fs.existsSync(csvFile)) {
  console.error('文件不存在:', csvFile);
  process.exit(1);
}

// 工具函数
function formatTime(str) {
  if (!str) return '';
  const [date, time] = str.split(' ');
  if (!date || !time) return str;
  const [y, m, d] = date.split('-');
  return `${y}-${parseInt(m)}-${parseInt(d)} ${time.split('.')[0]}`;
}
function pathToVarName(apiPath) {
  return apiPath.replace(/^\/|\"/g, '').replace(/\//g, '_');
}

// 自动递增 zip 文件名
function getNextZipName(base = 'mockData.zip') {
  let name = base;
  let idx = 1;
  while (fs.existsSync(path.resolve(process.cwd(), name))) {
    name = `mockData_${idx}.zip`;
    idx++;
  }
  return name;
}

// 主流程
(async () => {
  const rawData = await csv().fromFile(csvFile);
  const transformed = rawData.map((item) => {
    let data;
    try {
      data = JSON.parse(item.response_body.replace(/\\"/g, '"'));
    } catch(e) {
      data = {};
    }
    return {
      isSuccess: data.errCode === 0,
      responseTime: formatTime(item.time),
      duration: Number(item.total_time_cost),
      data,
    };
  });

  const pathMap = {};
  rawData.forEach((item, idx) => {
    const apiPath = item.path.split('?')[0].replace(/^\"|\"$/g, '');
    if (!pathMap[apiPath]) pathMap[apiPath] = [];
    pathMap[apiPath].push({
      ...transformed[idx],
      _rawTime: item.time,
    });
  });

  Object.keys(pathMap).forEach((apiPath) => {
    pathMap[apiPath].sort((a, b) => new Date(a._rawTime) - new Date(b._rawTime));
    pathMap[apiPath] = pathMap[apiPath].map(({ _rawTime, ...rest }) => rest);
  });

  // 生成所有文件内容到内存
  const files = [];
  const order = {};
  const importLines = [];
  const pushLines = [];

  Object.entries(pathMap).forEach(([apiPath, arr]) => {
    const varName = pathToVarName(apiPath);
    const dir = `mockData/${varName}`;
    const chunkSize = 100;
    const chunkCount = Math.ceil(arr.length / chunkSize);
    const cleanApiPath = apiPath.startsWith('/') ? apiPath.slice(1) : apiPath;
    order[cleanApiPath] = [];

    for (let i = 0; i < chunkCount; i++) {
      const chunk = arr.slice(i * chunkSize, (i + 1) * chunkSize);
      const fileName = `${i + 1}.js`;
      const filePath = `${dir}/${fileName}`;
      const content = 'export default ' + JSON.stringify(chunk, null, 2) + ';';
      files.push({ filePath, content });
      const importVar = `${varName}_${i + 1}`;
      importLines.push(`import ${importVar} from './${varName}/${fileName}';`);
      pushLines.push(`mockData['${cleanApiPath}'].push(...${importVar});`);
    }
  });

  // 生成 index.js 内容
  const indexJsContent = `
${importLines.join('\n')}

const mockData = ${JSON.stringify(order, null, 2)};

${pushLines.join('\n')}

export default mockData;
`;

  files.push({
    filePath: 'mockData/index.js',
    content: indexJsContent.trim() + '\n'
  });

  // 生成 zip
  const zipName = getNextZipName();
  const zipPath = path.resolve(process.cwd(), zipName);
  const zipfile = new yazl.ZipFile();

  for (const file of files) {
    zipfile.addBuffer(Buffer.from(file.content, 'utf8'), file.filePath);
  }

  zipfile.outputStream.pipe(fs.createWriteStream(zipPath)).on("close", function() {
    console.log(`已生成 ${zipName}`);
  });

  zipfile.end();
})();
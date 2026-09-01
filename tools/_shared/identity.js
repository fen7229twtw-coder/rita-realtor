/* ===================================================================
   Rita 對外文件的身分資訊 —— 全部工具共用這一份，改這裡就好。

   用一般 <script src="../_shared/identity.js"></script> 載入
   （不要加 type="module"），它才會在下面的程式跑之前先設定好。
   每支工具仍然保留自己的預設值當退路，所以這個檔沒載到也不會壞。

   ⚠ 經紀業名稱是法規要求，不是裝飾：
     不動產經紀業管理條例第 21 條 —— 廣告內容應與事實相符，
     並註明經紀業名稱；違反罰 6~30 萬（第 29 條，罰的是經紀業）。
     「熊理想有限公司」才是法規要的那個名字，店名是品牌名。

   ⚠ 是「青埔」不是「青浦」。
=================================================================== */
(function () {
  var ID = {
    name: '蕭沛縈 Rita',
    nickname: '青埔花媽',
    title: '桃園青埔專任房產顧問',
    /* 招牌上的店名 */
    firm: '有巢氏房屋　青埔IKEA店',
    /* 法規要註明的經紀業名稱 */
    company: '熊理想有限公司',
    /* 兩個併成一行，落款直接用這個 */
    firmLine: '有巢氏房屋　青埔IKEA店　熊理想有限公司',
    tel: '0981-456-399',
    telRaw: '0981456399',
    line: 'ritahaiao',
    lineUrl: 'https://line.me/ti/p/~ritahaiao',
    email: 'fen7229.tw.tw@gmail.com',
  };
  if (typeof window !== 'undefined') window.RITA_ID = ID;
  if (typeof globalThis !== 'undefined') globalThis.RITA_ID = ID;
})();

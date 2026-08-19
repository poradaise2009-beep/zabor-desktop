# Условия использования сервиса ZABOR / ZABOR Terms of Service

> Редакция от 18 августа 2026 года.
> Русская версия является основной и имеет преимущественную силу при расхождении с переводом.
> The Russian version is authoritative; the English translation follows below.

---

## Русская версия

### 1. Общие положения

Настоящие условия (**«Условия»**) регулируют использование **сервиса ZABOR** — серверной инфраструктуры, обеспечивающей регистрацию пользователей, обмен сигнальными сообщениями, голосовые каналы, звонки и синхронизацию состояния (**«Сервис»**).

Сервис предоставляется физическим лицом — vnkdevelop (**«Оператор»**), безвозмездно.

#### 1.1. Что Условия регулируют, а что нет

Это принципиальное разграничение:

- Условия регулируют **доступ к Сервису**, то есть к серверам Оператора.
- Условия **не ограничивают** и не могут ограничивать ваши права на программное обеспечение ZABOR, предоставленные лицензией [GPL-3.0](LICENSE). Право использовать, изучать, изменять и распространять код сохраняется за вами в полном объёме независимо от согласия с настоящими Условиями.

Оператор не обязан предоставлять доступ к своим серверам кому-либо: лицензия GPL-3.0 распространяется на программу, а не на инфраструктуру Оператора. Отказ в доступе к Сервису не является ограничением прав по GPL-3.0.

### 2. Принятие условий

Использование Сервиса, включая создание учётной записи и подключение приложения к серверу, означает согласие с Условиями. Если вы не согласны — не используйте Сервис; вы по-прежнему можете использовать приложение с собственным сервером.

Использовать Сервис могут лица, достигшие 14 лет. Лица от 14 до 18 лет используют Сервис с согласия законных представителей.

### 3. Учётная запись

1. При регистрации вы указываете имя пользователя и пароль. Вы отвечаете за сохранность пароля и за все действия, совершённые под вашей учётной записью.
2. Запрещено передавать доступ к учётной записи третьим лицам и регистрировать учётные записи автоматизированными средствами.
3. Оператор вправе отказать в регистрации имени, вводящего в заблуждение относительно принадлежности к Оператору либо нарушающего права третьих лиц.

### 4. Требования к клиентскому приложению

Это ключевой раздел. Он не ограничивает ваше право изменять код — он определяет, какие подключения принимает сервер Оператора.

1. К Сервису допускаются **только официальные сборки** приложения ZABOR, распространяемые Оператором через страницу [Releases](https://github.com/vnkdevelop/zabor-desktop/releases).
2. Официальные сборки при подключении передают серверу **подпись сборки**. Сервер проверяет её и вправе отклонить соединение при отсутствии либо недействительности подписи. Технические детали описаны в [docs/client-attestation.md](docs/client-attestation.md).
3. Запрещается подключать к Сервису:
   - самостоятельно собранные, изменённые и переупакованные сборки приложения;
   - форки и производные версии;
   - сторонние клиенты и программные средства, реализующие протокол Сервиса.
4. Запрещается обходить, отключать, подделывать и воспроизводить механизм проверки подписи сборки, а также извлекать для этих целей ключи из официальных сборок.
5. **Форки и производные версии обязаны использовать собственный серверный бэкенд.** Исходный код приложения открыт, и вы вправе развернуть собственный сервер; подключение производной версии к серверу Оператора не допускается.
6. Оператор вправе устанавливать минимальную поддерживаемую версию приложения и отклонять соединения устаревших версий, когда это необходимо для работоспособности и безопасности Сервиса.

Пункты 1–4 являются условиями доступа к инфраструктуре Оператора и не являются дополнительными ограничениями в смысле раздела 7 GPL-3.0 применительно к программе.

### 5. Запрещённые действия

При использовании Сервиса запрещается:

1. создавать чрезмерную нагрузку, проводить атаки на отказ в обслуживании, сканировать инфраструктуру, эксплуатировать уязвимости;
2. получать несанкционированный доступ к учётным записям и данным других пользователей;
3. рассылать спам, осуществлять массовые автоматизированные обращения, использовать Сервис для ботнетов и автоматизированного накопления учётных записей;
4. размещать и передавать материалы, распространение которых запрещено законом, а также материалы, нарушающие права третьих лиц;
5. осуществлять травлю, угрозы, преследование и умышленное создание помех связи другим пользователям;
6. записывать разговоры других участников без их согласия, когда такое согласие требуется по закону;
7. использовать Сервис для коммерческой перепродажи доступа без согласия Оператора;
8. выдавать себя за Оператора либо за официальную поддержку ZABOR.

### 6. Модерация и прекращение доступа

1. Оператор вправе ограничить, приостановить или прекратить доступ к Сервису при нарушении Условий — включая нарушение раздела 4 — без предварительного уведомления, если это необходимо для защиты Сервиса и его пользователей.
2. Оператор вправе применять серверные ограничения: отключение микрофона, исключение из канала, ограничение частоты запросов.
3. Оператор не обязан обосновывать решения о блокировке и восстанавливать доступ, но рассматривает обращения через [GitHub Issues](https://github.com/vnkdevelop/zabor-desktop/issues).

### 7. Данные пользователей

1. Сервер хранит: имя пользователя, хеш пароля, отображаемое имя, аватар, цвет аватара, текст «о себе», настройки звука, данные достижений и статус присутствия.
2. **Голос, видео и трансляции экрана передаются напрямую между участниками по технологии WebRTC (P2P) и не проходят через сервер Оператора.** Через сервер передаются только сигнальные сообщения, необходимые для установления соединения. При прямом соединении участники звонка получают сетевые адреса друг друга — это неотъемлемое свойство P2P-связи.
3. Оператор не продаёт и не передаёт данные третьим лицам, за исключением случаев, предусмотренных законом.
4. Сервер ведёт технические журналы подключений, включая версию и канал сборки приложения, время подключения и результат проверки подписи. Журналы используются для диагностики и защиты Сервиса.
5. Удаление учётной записи возможно по обращению к Оператору.

### 8. Доступность Сервиса

Сервис предоставляется на условиях **«как есть»** и **«как доступно»**. Оператор не гарантирует бесперебойную работу, сохранность данных, определённое качество связи и совместимость с конкретным оборудованием. Возможны технические перерывы, изменение или прекращение работы Сервиса без предварительного уведомления.

### 9. Ограничение ответственности

Сервис предоставляется безвозмездно. В максимально допустимом законом объёме Оператор не несёт ответственности за упущенную выгоду, утрату данных, невозможность использования Сервиса, качество связи и любые косвенные убытки, возникшие в связи с использованием или невозможностью использования Сервиса.

Ничто в настоящем разделе не исключает ответственность, которая не может быть исключена по законодательству Российской Федерации.

### 10. Изменение Условий

Оператор вправе изменять Условия. Действующая редакция публикуется в файле `TERMS.md` репозитория. Существенные изменения раздела 4 объявляются в описании релиза. Продолжение использования Сервиса после публикации новой редакции означает согласие с ней.

### 11. Применимое право

К Условиям применяется право Российской Федерации. Споры, не урегулированные путём переговоров, подлежат рассмотрению по месту жительства Оператора в соответствии с законодательством Российской Федерации.

### 12. Контакты

Обращения по вопросам Сервиса: [GitHub Issues](https://github.com/vnkdevelop/zabor-desktop/issues).
Сообщения об уязвимостях — приватно, через [Security Advisories](https://github.com/vnkdevelop/zabor-desktop/security/advisories/new).

---

## English version

### 1. General

These terms (the **"Terms"**) govern use of the **ZABOR service** — the server infrastructure providing user registration, signaling, voice channels, calls and state synchronization (the **"Service"**).

The Service is provided by an individual, vnkdevelop (the **"Operator"**), free of charge.

#### 1.1. What the Terms do and do not govern

This distinction is fundamental:

- The Terms govern **access to the Service**, i.e. to the Operator's servers.
- The Terms do **not** restrict, and cannot restrict, your rights in the ZABOR software granted by the [GPL-3.0](LICENSE) license. Your rights to use, study, modify and redistribute the code remain fully intact regardless of whether you accept these Terms.

The Operator is under no obligation to provide anyone with access to its servers: GPL-3.0 covers the program, not the Operator's infrastructure. Denying access to the Service is not a restriction of GPL-3.0 rights.

### 2. Acceptance

Using the Service, including creating an account and connecting the application to the server, constitutes acceptance of these Terms. If you do not agree, do not use the Service; you may still run the application against your own server.

The Service may be used by persons aged 14 and over. Persons aged 14 to 18 must have the consent of their legal guardians.

### 3. Accounts

1. Registration requires a username and password. You are responsible for keeping your password secure and for all activity under your account.
2. Sharing account access with third parties and creating accounts by automated means are prohibited.
3. The Operator may refuse a username that misleads as to affiliation with the Operator or infringes third-party rights.

### 4. Client application requirements

This is the key section. It does not limit your right to modify the code — it defines which connections the Operator's server accepts.

1. Only **official builds** of the ZABOR application, distributed by the Operator via the [Releases](https://github.com/vnkdevelop/zabor-desktop/releases) page, are admitted to the Service.
2. Official builds transmit a **build signature** on connection. The server verifies it and may reject connections presenting no signature or an invalid one. Technical details are described in [docs/client-attestation.md](docs/client-attestation.md).
3. You must not connect to the Service:
   - self-built, modified or repackaged builds of the application;
   - forks and derivative versions;
   - third-party clients or tools implementing the Service protocol.
4. You must not circumvent, disable, forge or reproduce the build-signature mechanism, nor extract keys from official builds for those purposes.
5. **Forks and derivatives must run their own server backend.** The application source is open and you are free to deploy your own server; connecting a derivative to the Operator's server is not permitted.
6. The Operator may set a minimum supported application version and reject connections from outdated versions where necessary for the Service's operability and security.

Sections 1–4 are conditions of access to the Operator's infrastructure and are not further restrictions within the meaning of GPL-3.0 section 7 as applied to the program.

### 5. Prohibited conduct

When using the Service, you must not:

1. create excessive load, conduct denial-of-service attacks, scan the infrastructure or exploit vulnerabilities;
2. gain unauthorized access to other users' accounts or data;
3. send spam, issue mass automated requests, or use the Service for botnets or automated account farming;
4. post or transmit material whose distribution is prohibited by law, or material infringing third-party rights;
5. engage in harassment, threats, stalking, or deliberate disruption of other users' communications;
6. record other participants' conversations without their consent where such consent is required by law;
7. commercially resell access to the Service without the Operator's consent;
8. impersonate the Operator or official ZABOR support.

### 6. Moderation and termination

1. The Operator may restrict, suspend or terminate access to the Service upon breach of these Terms — including breach of section 4 — without prior notice where necessary to protect the Service and its users.
2. The Operator may apply server-side restrictions: server mute, removal from a channel, rate limiting.
3. The Operator is not obliged to justify enforcement decisions or restore access, but will consider appeals via [GitHub Issues](https://github.com/vnkdevelop/zabor-desktop/issues).

### 7. User data

1. The server stores: username, password hash, display name, avatar, avatar color, "about me" text, audio settings, achievement data and presence status.
2. **Voice, video and screen shares are transmitted directly between participants over WebRTC (P2P) and do not pass through the Operator's server.** Only the signaling messages needed to establish a connection traverse the server. In a direct connection, call participants learn each other's network addresses — this is inherent to P2P communication.
3. The Operator does not sell or transfer data to third parties except as required by law.
4. The server keeps technical connection logs, including application version and build channel, connection time and signature verification result. Logs are used for diagnostics and to protect the Service.
5. Account deletion is available on request to the Operator.

### 8. Availability

The Service is provided **"as is"** and **"as available"**. The Operator does not warrant uninterrupted operation, data retention, any particular call quality, or compatibility with specific hardware. Maintenance interruptions, changes or discontinuation of the Service may occur without prior notice.

### 9. Limitation of liability

The Service is provided free of charge. To the maximum extent permitted by law, the Operator is not liable for lost profits, data loss, inability to use the Service, call quality, or any indirect damages arising from use of or inability to use the Service.

Nothing in this section excludes liability that cannot be excluded under the legislation of the Russian Federation.

### 10. Changes to the Terms

The Operator may amend these Terms. The current version is published in the repository's `TERMS.md`. Material changes to section 4 will be announced in the release notes. Continued use of the Service after publication constitutes acceptance.

### 11. Governing law

These Terms are governed by the law of the Russian Federation. Disputes not resolved through negotiation shall be heard at the Operator's place of residence in accordance with the legislation of the Russian Federation.

### 12. Contact

Service enquiries: [GitHub Issues](https://github.com/vnkdevelop/zabor-desktop/issues).
Vulnerability reports: privately, via [Security Advisories](https://github.com/vnkdevelop/zabor-desktop/security/advisories/new).

---

Copyright © 2026 vnkdevelop.

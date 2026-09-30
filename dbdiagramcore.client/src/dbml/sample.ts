export const SAMPLE_DBML = `// 歡迎使用 DBDiagram！在左側以 DBML 描述資料庫，右側會即時產生關聯圖。
// 語法說明：https://dbml.dbdiagram.io/docs

Project ecommerce {
  database_type: 'PostgreSQL'
  Note: '電子商務範例資料庫'
}

Table users as U {
  id integer [pk, increment]
  full_name varchar(100) [not null]
  email varchar(255) [unique, not null]
  gender gender
  date_of_birth date
  created_at timestamp [default: \`now()\`]
  country_code int [ref: > countries.code]

  Note: '會員資料'
}

Table countries [headercolor: #16a085] {
  code int [pk]
  name varchar [not null]
  continent_name varchar
}

Table merchants [headercolor: #8e44ad] {
  id int [pk]
  merchant_name varchar
  country_code int
  admin_id int [ref: > U.id]
  created_at timestamp [default: \`now()\`]
}

Table products [headercolor: #d35400] {
  id int [pk, increment]
  name varchar [not null]
  merchant_id int [not null]
  price decimal(10, 2) [default: 0, note: '售價（含稅）']
  status product_status
  created_at timestamp [default: \`now()\`]

  indexes {
    (merchant_id, status) [name: 'product_status']
    id [unique]
  }
}

Table orders [headercolor: #2980b9] {
  id int [pk, increment]
  user_id int [not null]
  status order_status [default: 'created']
  created_at timestamp [default: \`now()\`]
}

Table order_items [headercolor: #2980b9] {
  order_id int [pk]
  product_id int [pk]
  quantity int [default: 1]
}

Enum order_status {
  created [note: '已建立']
  paid
  shipped
  done
}

Enum product_status {
  out_of_stock
  in_stock
  running_low [note: '庫存低於 20']
}

Enum gender {
  male
  female
  other
}

Ref: merchants.country_code > countries.code
Ref: products.merchant_id > merchants.id [delete: cascade]
Ref: orders.user_id > users.id
Ref: order_items.order_id > orders.id [delete: cascade]
Ref: order_items.product_id > products.id

TableGroup commerce [color: #2980b9] {
  orders
  order_items
}
`

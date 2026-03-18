import React, { useState, useEffect } from 'react';
import { Layout, Button, Select, Space, Card, Toast, Typography } from '@douyinfe/semi-ui';
import { IconPlus } from '@douyinfe/semi-icons';
import { Todo, FilterParams, CreateTodoDto, UpdateTodoDto } from './types/todo';
import { todoApi } from './api/todo';
import TodoList from './components/TodoList';
import TodoForm from './components/TodoForm';
import '@douyinfe/semi-ui/dist/css/semi.min.css';

const { Header, Content } = Layout;
const { Title } = Typography;

const App: React.FC = () => {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [filteredTodos, setFilteredTodos] = useState<Todo[]>([]);
  const [formVisible, setFormVisible] = useState(false);
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null);
  const [filters, setFilters] = useState<FilterParams>({
    status: 'all',
    priority: 'all',
  });
  const [loading, setLoading] = useState(false);

  // 加载TODO列表
  const loadTodos = async () => {
    try {
      setLoading(true);
      const data = await todoApi.getTodos();
      setTodos(data);
      applyFilters(data, filters);
    } catch (error) {
      Toast.error('加载TODO列表失败');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  // 应用筛选
  const applyFilters = (data: Todo[], filter: FilterParams) => {
    let result = [...data];
    if (filter.status && filter.status !== 'all') {
      result = result.filter(todo => todo.status === filter.status);
    }
    if (filter.priority && filter.priority !== 'all') {
      result = result.filter(todo => todo.priority === filter.priority);
    }
    setFilteredTodos(result);
  };

  useEffect(() => {
    loadTodos();
  }, []);

  useEffect(() => {
    applyFilters(todos, filters);
  }, [filters, todos]);

  // 新增TODO
  const handleCreate = async (data: CreateTodoDto) => {
    try {
      await todoApi.createTodo(data);
      Toast.success('创建成功');
      loadTodos();
    } catch (error) {
      Toast.error('创建失败');
      console.error(error);
    }
  };

  // 编辑TODO
  const handleEdit = async (data: UpdateTodoDto) => {
    if (!editingTodo) return;
    try {
      await todoApi.updateTodo(editingTodo.id, data);
      Toast.success('更新成功');
      loadTodos();
      setEditingTodo(null);
    } catch (error) {
      Toast.error('更新失败');
      console.error(error);
    }
  };

  // 删除TODO
  const handleDelete = async (id: number) => {
    try {
      await todoApi.deleteTodo(id);
      Toast.success('删除成功');
      loadTodos();
    } catch (error) {
      Toast.error('删除失败');
      console.error(error);
    }
  };

  const handleFormSubmit = (data: CreateTodoDto | UpdateTodoDto) => {
    if (editingTodo) {
      handleEdit(data);
    } else {
      handleCreate(data as CreateTodoDto);
    }
  };

  return (
    <Layout className="layout" style={{ minHeight: '100vh', background: '#f7f8fa' }}>
      <Header style={{ background: '#fff', padding: '0 24px', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
          <Title heading={3} style={{ margin: 0 }}>TODO 管理系统</Title>
        </div>
      </Header>
      <Content style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
        <Card>
          <Space style={{ marginBottom: 24 }}>
            <Button
              type="primary"
              icon={<IconPlus />}
              onClick={() => {
                setEditingTodo(null);
                setFormVisible(true);
              }}
            >
              新增TODO
            </Button>
            <Select
              placeholder="筛选状态"
              value={filters.status}
              onChange={(value) => setFilters({ ...filters, status: value as any })}
              style={{ width: 120 }}
            >
              <Select.Option value="all">全部状态</Select.Option>
              <Select.Option value="pending">待办</Select.Option>
              <Select.Option value="in_progress">进行中</Select.Option>
              <Select.Option value="completed">已完成</Select.Option>
            </Select>
            <Select
              placeholder="筛选优先级"
              value={filters.priority}
              onChange={(value) => setFilters({ ...filters, priority: value as any })}
              style={{ width: 120 }}
            >
              <Select.Option value="all">全部优先级</Select.Option>
              <Select.Option value="low">低</Select.Option>
              <Select.Option value="medium">中</Select.Option>
              <Select.Option value="high">高</Select.Option>
            </Select>
          </Space>

          <TodoList
            todos={filteredTodos}
            onEdit={(todo) => {
              setEditingTodo(todo);
              setFormVisible(true);
            }}
            onDelete={handleDelete}
          />
        </Card>
      </Content>

      <TodoForm
        visible={formVisible}
        todo={editingTodo}
        onCancel={() => setFormVisible(false)}
        onSubmit={handleFormSubmit}
      />
    </Layout>
  );
};

export default App;
